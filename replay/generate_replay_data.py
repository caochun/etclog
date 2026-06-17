#!/usr/bin/env python3
import argparse
import json
import re
from pathlib import Path


TITLE_RE = re.compile(r"^# Vehicle Log Merge: (.+)$")
TIMELINE_RE = re.compile(r"^### ([0-9-]+ [0-9:.]+) `([^`]+)`$")


DEVICE_RULES = [
    ("axle", ("车轴型", "DevInfo/Axle", "AxleInfo", "轴型")),
    ("vlpr", ("DevInfo/Vlpr", "牌识", "picId", "抓拍", "车牌匹配")),
    ("weigh", ("称重", "治超", "weight", "Weight", "超限", "限重")),
    ("display", ("LED", "信息显示屏", "费显", "显示屏", "情报板")),
    ("rsu", ("RSU", "OBU", "B2帧", "B4帧", "E1帧", "E2帧", "天线")),
    ("cpc", ("CPC", "cpc", "mediaNo", "卡片信息确认")),
    ("lane", ("线圈", "压线圈", "车辆队列", "车道", "车辆检测器", "车检器", "车检状态")),
    ("barrier", ("栏杆", "抬杆", "落杆", "栏杆机", "放行控制")),
    ("namelist", ("名单", "黑名单", "灰名单")),
    ("fee", ("计费", "fee", "Fee", "收费", "payFee")),
    ("mq", ("MQTT", "发布", "收到消息", "TransShare", "StationTransData", "WasteData")),
    ("store", ("流水", "入库", "redis", "Redis", "备份")),
    ("service", ("交易受理", "有效性判断", "车辆交易数据处理", "校验")),
]


TYPE_RULES = [
    ("success", ("交易成功", "操作成功", "入库成功", "transStatus\":0")),
    ("reject", ("拒绝", "失败", "不允通行", "拆卸", "标签无卡", "称重数据缺失", "异常")),
    ("plate", ("牌识", "plateNum", "车牌匹配", "抓拍")),
    ("weight", ("称重", "治超", "weight", "Weight")),
    ("billing", ("计费", "收费", "payFee", "fee")),
    ("message", ("MQTT", "发布", "收到消息", "TransShare", "StationTransData", "WasteData")),
    ("store", ("流水", "入库", "redis", "备份")),
    ("read", ("RSU", "OBU", "B2", "B4", "CPC", "卡片")),
]


def first_match(text, pattern):
    match = re.search(pattern, text)
    return match.group(1) if match else None


def detect_coil_id(text):
    return first_match(text, r"线圈为:(\d+)号") or first_match(text, r"车检器(\d+)")


def detect_coil_state(text):
    value = first_match(text, r"改变后的状态为:(true|false)")
    if value:
        return value == "true"
    value = first_match(text, r"车检状态:车检器\d+(有信号|无信号)")
    if value:
        return value == "有信号"
    return None


def infer_lane_profile(entries):
    coil_ids = {entry["coilId"] for entry in entries if entry["coilId"]}
    if {"1", "2"} & coil_ids:
        return "etc"
    if "6" in coil_ids:
        return "mtc"

    mtc_count = sum("MTC" in entry["raw"] for entry in entries)
    etc_count = sum("ETC" in entry["raw"] or "OBU" in entry["raw"] or "RSU" in entry["raw"] for entry in entries)
    if mtc_count > etc_count:
        return "mtc"
    if etc_count:
        return "etc"
    return "unknown"


def coil_label(coil_id, lane_profile):
    if coil_id == "1":
        return "ETC车辆检测器1"
    if coil_id == "2":
        return "ETC车辆检测器2"
    if coil_id == "6":
        return "存在线圈6"
    if coil_id == "7":
        return "落杆线圈7"
    return None


def detect_station(entries):
    for entry in entries:
        for pattern in (
            r'"stationName":"([^"]+)"',
            r'"exTollStationName":"([^"]+)"',
            r'"enTollStationName":"([^"]+)"',
            r'"stationName":\s*"([^"]+)"',
        ):
            value = first_match(entry["raw"], pattern)
            if value:
                return value
    return None


def detect_lane(entries):
    lanes = [entry["lane"] for entry in entries if entry["lane"]]
    if lanes:
        return lanes[0]
    return None


def passage_title(vehicle, entries):
    if not entries:
        return vehicle
    start = entries[0]["time"][:19]
    station = detect_station(entries) or "未知站"
    lane = detect_lane(entries)
    lane_text = f"{lane}车道" if lane else "未知车道"
    return f"{vehicle} {start} 过 {station} {lane_text}"


def classify(text):
    device = "service"
    for candidate, needles in DEVICE_RULES:
        if any(needle in text for needle in needles):
            device = candidate
            break

    kind = "process"
    for candidate, needles in TYPE_RULES:
        if any(needle in text for needle in needles):
            kind = candidate
            break

    severity = "info"
    if "[ERROR]" in text or kind == "reject":
        severity = "error"
    elif kind == "success":
        severity = "success"
    elif "[WARN]" in text:
        severity = "warn"

    return device, kind, severity


def summarize(text):
    markers = [
        r"\[(处理流程\|[^]]+)\]",
        r"\[(数据交互\|[^]]+)\]",
        r"\[(OBU信息\|[^]]+)\]",
        r"\[(ETC卡信息\|[^]]+)\]",
        r"\[(流水传输)\]",
    ]
    prefix = None
    for pattern in markers:
        prefix = first_match(text, pattern)
        if prefix:
            break

    message = text.split("|", 1)[-1] if "|" in text else text
    message = re.sub(r"\s+", " ", message).strip()
    if len(message) > 180:
        message = message[:177] + "..."
    return f"{prefix} | {message}" if prefix else message


def parse_markdown(path):
    vehicle = path.stem
    entries = []
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    idx = 0
    while idx < len(lines):
        title = TITLE_RE.match(lines[idx])
        if title:
            vehicle = title.group(1)
        timeline = TIMELINE_RE.match(lines[idx])
        if not timeline:
            idx += 1
            continue

        ts, source = timeline.groups()
        idx += 1
        while idx < len(lines) and lines[idx] != "```text":
            idx += 1
        idx += 1
        text_lines = []
        while idx < len(lines) and lines[idx] != "```":
            text_lines.append(lines[idx])
            idx += 1

        raw = "\n".join(text_lines)
        device, kind, severity = classify(raw)
        coil_id = detect_coil_id(raw)
        coil_state = detect_coil_state(raw)
        lane = first_match(raw, r"\b(37016433[0-9A-F]{2})\b")
        trade_id = first_match(raw, r'"tradeId":"([^"]+)"')
        pass_id = first_match(raw, r'"passId":"([^"]+)"')
        fee_vehicle = first_match(raw, r'"feeVehicleId":"([^"]+)"')
        reason = first_match(raw, r'"desc":"([^"]*)"') or first_match(raw, r"失败原因：([^,，\s]+)")

        entries.append(
            {
                "time": ts,
                "source": source,
                "raw": raw,
                "summary": summarize(raw),
                "device": device,
                "kind": kind,
                "severity": severity,
                "lane": lane,
                "coilId": coil_id,
                "coilState": coil_state,
                "coilLabel": None,
                "tradeId": trade_id,
                "passId": pass_id,
                "vehicleId": fee_vehicle,
                "reason": reason,
            }
        )
        idx += 1

    lane_profile = infer_lane_profile(entries)
    for entry in entries:
        entry["coilLabel"] = coil_label(entry["coilId"], lane_profile)

    return {
        "vehicle": vehicle,
        "sourceFile": path.name,
        "laneProfile": lane_profile,
        "passageTitle": passage_title(vehicle, entries),
        "events": entries,
    }


def main():
    parser = argparse.ArgumentParser(description="Generate 3D replay JSON from merged vehicle logs.")
    parser.add_argument("inputs", nargs="*", type=Path, default=sorted(Path(".").glob("merged_*.md")))
    parser.add_argument("--out-dir", type=Path, default=Path("replay/data"))
    args = parser.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)
    index = []
    for path in args.inputs:
        replay = parse_markdown(path)
        if not replay["events"]:
            continue
        out_name = f"{path.stem}.json"
        out_path = args.out_dir / out_name
        out_path.write_text(json.dumps(replay, ensure_ascii=False, indent=2), encoding="utf-8")
        index.append(
            {
                "file": out_name,
                "vehicle": replay["vehicle"],
                "sourceFile": path.name,
                "eventCount": len(replay["events"]),
                "start": replay["events"][0]["time"],
                "end": replay["events"][-1]["time"],
            }
        )

    (args.out_dir / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {len(index)} replay files to {args.out_dir}")


if __name__ == "__main__":
    main()
