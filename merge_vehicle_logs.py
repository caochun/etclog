#!/usr/bin/env python3
import argparse
import datetime as dt
import re
import sys
from dataclasses import dataclass
from pathlib import Path


TS_RE = re.compile(r"^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]")
JSON_STRING_RE = re.compile(r'"([A-Za-z][A-Za-z0-9_]*)"\s*:\s*"([^"]{3,220})"')
JAVA_FIELD_RE = re.compile(r"\b([A-Za-z][A-Za-z0-9_]*)=([^,'\"\])\s]{3,220})")
FILENAME_RE = re.compile(r"[A-Z0-9_]+_(?:REQ|RES)_[0-9A-F]{8,10}_\d{17}\.json")
REDIS_KEY_RE = re.compile(r"\b(?:BAK_)?WASTE_[^\s,，}）)]{8,260}")
PLATE_PREFIXES = "京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领港澳"
PLATE_TOKEN_RE = re.compile(rf"[{PLATE_PREFIXES}][A-Z][A-Z0-9]{{5,6}}(?:_\d{{1,3}})?")
HEX_VALUE_RE = re.compile(r"[0-9A-Fa-f]+")
LANE_RE = re.compile(r"\b37016433[0-9A-F]{2}\b")

KEY_FIELDS = {
    "msgId",
    "filename",
    "mediaNo",
    "cardId",
    "cardid",
    "obuId",
    "oBUSN",
    "obuSn",
    "obusn",
    "serialNumber",
    "cpuId",
    "cpcId",
    "tradeId",
    "passId",
    "vehicleId",
    "feeVehicleId",
    "identifyVehicleId",
    "plateNum",
    "vlp",
    "redisKey",
    "vehiclesignid",
}
EXPAND_KEY_FIELDS = KEY_FIELDS - {"msgId", "filename"}

NOISY_VALUES = {
    "NONE",
    "null",
    "null_null",
}


@dataclass(frozen=True)
class LogLine:
    ts: dt.datetime
    path: Path
    line_no: int
    text: str


@dataclass(frozen=True)
class VehicleEvent:
    vehicle: str
    lines: list[LogLine]


def parse_ts(line: str):
    match = TS_RE.match(line)
    if not match:
        return None
    return dt.datetime.strptime(match.group(1), "%Y-%m-%d %H:%M:%S.%f")


def file_kind(path: Path) -> str:
    name = path.name
    if "_etc_" in name:
        return "etc"
    if "_mtc_" in name:
        return "mtc"
    if "_namelist_" in name:
        return "namelist"
    if "_data_" in name:
        return "data"
    if "_fee_" in name:
        return "fee"
    return "field"


def parse_datetime(value: str):
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return dt.datetime.strptime(value, fmt)
        except ValueError:
            pass
    raise argparse.ArgumentTypeError(f"invalid datetime: {value!r}")


def clean_value(value: str) -> str:
    return value.strip().strip("'\"")


def looks_like_hex_plate(value: str) -> bool:
    return len(value) >= 16 and HEX_VALUE_RE.fullmatch(value) is not None


def should_keep_value(value: str, field: str | None = None) -> bool:
    value = clean_value(value)
    if value in NOISY_VALUES:
        return False
    if len(value) >= 8 and set(value) == {"0"}:
        return False
    if len(value) < 4:
        return False
    if value.startswith("http://") or value.startswith("https://"):
        return False
    if field in {"plateNum", "vlp"} and looks_like_hex_plate(value):
        return False
    return True


def normalize_plate(value: str) -> str:
    return re.sub(r"_\d{1,3}$", "", value)


def extract_plate_tokens(text: str) -> set[str]:
    return {normalize_plate(plate) for plate in PLATE_TOKEN_RE.findall(text)}


def has_foreign_plate(text: str, vehicle: str) -> bool:
    plates = PLATE_TOKEN_RE.findall(text)
    if not plates:
        return False
    target = normalize_plate(vehicle)
    return all(normalize_plate(plate) != target for plate in plates)


def key_matches_vehicle(value: str, vehicle: str) -> bool:
    return not has_foreign_plate(value, vehicle)


def extract_keys(text: str, vehicle: str, *, expandable_only: bool = False) -> set[str]:
    keys = set()

    def add_key(value: str, field: str | None = None):
        value = clean_value(value)
        if should_keep_value(value, field) and key_matches_vehicle(value, vehicle):
            keys.add(value)

    if not expandable_only:
        for value in FILENAME_RE.findall(text):
            add_key(value)

    for value in REDIS_KEY_RE.findall(text):
        add_key(value)

    key_fields = EXPAND_KEY_FIELDS if expandable_only else KEY_FIELDS
    for field, value in JSON_STRING_RE.findall(text):
        if field in key_fields:
            add_key(value, field)

    for field, value in JAVA_FIELD_RE.findall(text):
        if field in key_fields:
            add_key(value, field)

    if vehicle in text:
        keys.add(vehicle)
        keys.add(f"{vehicle}_0")

    return keys


def line_matches(text: str, keys: set[str], vehicle: str) -> bool:
    if has_foreign_plate(text, vehicle):
        return False
    return any(key and key in text for key in sorted(keys, key=len, reverse=True))


def iter_files(log_dir: Path, around: dt.datetime | None, window: dt.timedelta):
    files = sorted(log_dir.glob("*.log"))
    if around is None:
        return files

    wanted_hours = set()
    start = around - window
    end = around + window
    cur = start.replace(minute=0, second=0, microsecond=0)
    while cur <= end:
        wanted_hours.add(cur.strftime("%Y%m%d_%H"))
        cur += dt.timedelta(hours=1)

    selected = []
    for path in files:
        name = path.name
        if any(hour in name for hour in wanted_hours):
            selected.append(path)
    return selected


def read_matching_lines(files, keys: set[str], vehicle: str, around, window) -> tuple[list[LogLine], set[str]]:
    matches = []
    new_keys = set()
    start = around - window if around else None
    end = around + window if around else None

    for path in files:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line_no, line in enumerate(handle, 1):
                if not line_matches(line, keys, vehicle):
                    continue
                ts = parse_ts(line)
                if ts is None:
                    continue
                if start and (ts < start or ts > end):
                    continue
                line = line.rstrip("\n")
                matches.append(LogLine(ts, path, line_no, line))
                new_keys.update(extract_keys(line, vehicle, expandable_only=True))

    return matches, new_keys


def cluster_seed_lines(log_dir: Path, vehicle: str, gap: dt.timedelta):
    seed_lines = []
    for path in sorted(log_dir.glob("*.log")):
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line_no, line in enumerate(handle, 1):
                if vehicle not in line:
                    continue
                ts = parse_ts(line)
                if ts is None:
                    continue
                seed_lines.append(LogLine(ts, path, line_no, line.rstrip("\n")))

    seed_lines.sort(key=lambda item: item.ts)
    clusters = []
    for item in seed_lines:
        if not clusters or item.ts - clusters[-1][-1].ts > gap:
            clusters.append([item])
        else:
            clusters[-1].append(item)

    return clusters


def discover_vehicle_events(
    log_dir: Path,
    around: dt.datetime | None,
    window: dt.timedelta,
    gap: dt.timedelta,
) -> list[VehicleEvent]:
    lines_by_vehicle: dict[str, list[LogLine]] = {}

    for path in iter_files(log_dir, around, window):
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line_no, line in enumerate(handle, 1):
                ts = parse_ts(line)
                if ts is None:
                    continue
                if around:
                    start = around - window
                    end = around + window
                    if ts < start or ts > end:
                        continue

                plates = extract_plate_tokens(line)
                if not plates:
                    continue

                item = LogLine(ts, path, line_no, line.rstrip("\n"))
                for vehicle in plates:
                    lines_by_vehicle.setdefault(vehicle, []).append(item)

    events = []
    for vehicle, lines in lines_by_vehicle.items():
        lines.sort(key=lambda item: (item.ts, str(item.path), item.line_no))
        clusters = []
        for item in lines:
            if not clusters or item.ts - clusters[-1][-1].ts > gap:
                clusters.append([item])
            else:
                clusters[-1].append(item)
        for cluster in clusters:
            events.append(VehicleEvent(vehicle, cluster))

    return sorted(events, key=lambda event: (event.lines[0].ts, event.vehicle))


def output_name_for_event(event: VehicleEvent) -> str:
    start = event.lines[0].ts.strftime("%Y%m%d_%H%M%S")
    return f"merged_{event.vehicle}_{start}.md"


def anchor_and_window_for_event(event: VehicleEvent, minimum_window: dt.timedelta):
    start = event.lines[0].ts
    end = event.lines[-1].ts
    duration = end - start
    anchor = start + duration / 2
    window = max(minimum_window, duration / 2 + dt.timedelta(seconds=30))
    return anchor, window


def summarize_cluster(cluster: list[LogLine], vehicle: str) -> str:
    lanes = set()
    kinds = set()
    for item in cluster:
        lanes.update(LANE_RE.findall(item.text))
        lanes.update(LANE_RE.findall(item.path.name))
        kinds.add(file_kind(item.path))
    start = cluster[0].ts.strftime("%Y-%m-%d %H:%M:%S")
    end = cluster[-1].ts.strftime("%Y-%m-%d %H:%M:%S")
    lane_text = ", ".join(sorted(lanes)) if lanes else "-"
    kind_text = ", ".join(sorted(kinds))
    return f"{vehicle} | {start} ~ {end} | lines={len(cluster)} | lanes={lane_text} | sources={kind_text}"


def merge_vehicle(log_dir: Path, vehicle: str, around, window, max_rounds: int):
    files = iter_files(log_dir, around, window)
    keys = {vehicle, f"{vehicle}_0"}
    all_matches = {}

    for _ in range(max_rounds):
        matches, new_keys = read_matching_lines(files, keys, vehicle, around, window)
        for item in matches:
            all_matches[(str(item.path), item.line_no)] = item

        before = len(keys)
        keys.update(k for k in new_keys if should_keep_value(k))
        if len(keys) == before:
            break

    return sorted(all_matches.values(), key=lambda item: (item.ts, str(item.path), item.line_no)), keys


def write_markdown(out, vehicle: str, log_dir: Path, around, window, matches, keys):
    print(f"# Vehicle Log Merge: {vehicle}", file=out)
    print("", file=out)
    print(f"- log_dir: `{log_dir}`", file=out)
    if around:
        print(f"- time_window: `{around - window}` ~ `{around + window}`", file=out)
    else:
        print("- time_window: full directory", file=out)
    print(f"- matched_lines: {len(matches)}", file=out)
    print(f"- extracted_keys: {len(keys)}", file=out)
    print("", file=out)
    print("## Keys", file=out)
    print("", file=out)
    for key in sorted(keys):
        print(f"- `{key}`", file=out)
    print("", file=out)
    print("## Timeline", file=out)
    print("", file=out)

    for item in matches:
        rel = item.path.relative_to(log_dir.parent)
        print(f"### {item.ts.strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]} `{rel}:{item.line_no}`", file=out)
        print("", file=out)
        print("```text", file=out)
        print(item.text, file=out)
        print("```", file=out)
        print("", file=out)


def write_discovered_events(args, log_dir: Path, events: list[VehicleEvent], output_dir: Path | None):
    if not events:
        print("no vehicle events found")
        return 1

    events = [event for event in events if len(event.lines) >= args.min_lines]
    if args.limit:
        events = events[: args.limit]

    if output_dir:
        output_dir.mkdir(parents=True, exist_ok=True)

    for idx, event in enumerate(events, 1):
        print(f"{idx}. {summarize_cluster(event.lines, event.vehicle)}")
        if output_dir:
            event_anchor, event_window = anchor_and_window_for_event(
                event,
                dt.timedelta(minutes=args.window_minutes),
            )
            matches, keys = merge_vehicle(
                log_dir=log_dir,
                vehicle=event.vehicle,
                around=event_anchor,
                window=event_window,
                max_rounds=args.rounds,
            )
            output_path = output_dir / output_name_for_event(event)
            with output_path.open("w", encoding="utf-8") as handle:
                write_markdown(handle, event.vehicle, log_dir, event_anchor, event_window, matches, keys)
            print(f"   wrote {output_path} ({len(matches)} lines, {len(keys)} keys)")

    if output_dir:
        print(f"done: wrote {len(events)} files to {output_dir}")

    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Merge lane and service logs for one vehicle passage."
    )
    parser.add_argument("vehicle", nargs="?", help="vehicle plate, for example: 鲁UQC322")
    parser.add_argument("--log-dir", default="20260514", type=Path)
    parser.add_argument("--at", type=parse_datetime, help="anchor time, e.g. '2026-05-14 08:00:28'")
    parser.add_argument("--window-minutes", type=int, default=5)
    parser.add_argument("--rounds", type=int, default=2)
    parser.add_argument("--auto", action="store_true", help="discover and merge all candidate vehicle passages")
    parser.add_argument("--discover", action="store_true", help="discover candidate vehicle passages")
    parser.add_argument("--discover-output-dir", type=Path, help="write one merged markdown file per discovered event")
    parser.add_argument("--min-lines", type=int, default=1, help="minimum seed lines for --auto/--discover output")
    parser.add_argument("--limit", type=int, help="maximum discovered events to print or write")
    parser.add_argument("--list-events", action="store_true", help="list candidate passages instead of merging")
    parser.add_argument("--gap-minutes", type=int, default=10, help="event split gap in minutes")
    parser.add_argument("-o", "--output", type=Path, help="markdown output path")
    args = parser.parse_args(argv)

    log_dir = args.log_dir
    if not log_dir.exists():
        raise SystemExit(f"log dir not found: {log_dir}")

    if args.auto or args.discover:
        events = discover_vehicle_events(
            log_dir=log_dir,
            around=args.at,
            window=dt.timedelta(minutes=args.window_minutes),
            gap=dt.timedelta(minutes=args.gap_minutes),
        )
        output_dir = args.discover_output_dir
        if args.auto and output_dir is None:
            output_dir = Path(f"{log_dir.name}_merged")
        return write_discovered_events(args, log_dir, events, output_dir)

    if not args.vehicle:
        parser.error("vehicle is required unless --auto or --discover is used")

    if args.list_events:
        clusters = cluster_seed_lines(log_dir, args.vehicle, dt.timedelta(minutes=args.gap_minutes))
        if not clusters:
            print(f"no events found for {args.vehicle}")
            return 1
        for idx, cluster in enumerate(clusters, 1):
            print(f"{idx}. {summarize_cluster(cluster, args.vehicle)}")
        return 0

    if args.at is None:
        print("warning: --at was not provided; scanning the full directory may merge multiple passages.", file=sys.stderr)

    matches, keys = merge_vehicle(
        log_dir=log_dir,
        vehicle=args.vehicle,
        around=args.at,
        window=dt.timedelta(minutes=args.window_minutes),
        max_rounds=args.rounds,
    )

    if args.output:
        with args.output.open("w", encoding="utf-8") as handle:
            write_markdown(handle, args.vehicle, log_dir, args.at, dt.timedelta(minutes=args.window_minutes), matches, keys)
        print(f"wrote {args.output} ({len(matches)} lines, {len(keys)} keys)")
    else:
        write_markdown(sys.stdout, args.vehicle, log_dir, args.at, dt.timedelta(minutes=args.window_minutes), matches, keys)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
