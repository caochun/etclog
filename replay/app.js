import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const deviceInfo = {
  vlpr: { label: "车牌识别", color: 0x5fb3ff, z: -22, x: -3.25 },
  axle: { label: "车型识别", color: 0xf2c94c, z: -18.5, x: -3.25 },
  weigh: { label: "称重/治超", color: 0xf2994a, z: -11.5, x: 3.6 },
  lane: { label: "车检器", color: 0x8bd17c, z: -13.5, x: -3.25 },
  rsu: { label: "RSU/ETC天线", color: 0x56ccf2, z: 14.5, x: 0 },
  cpc: { label: "CPC读卡", color: 0xbb6bd9, z: 6, x: -3.25 },
  display: { label: "费显/LED", color: 0xf7d154, z: 18.6, x: -3.25 },
  barrier: { label: "栏杆", color: 0xeb5757, z: 24, x: 0 },
  service: { label: "交易服务", color: 0x75a7ff, z: -13, x: 6.2 },
  namelist: { label: "名单服务", color: 0x9b8cff, z: -6, x: 6.2 },
  fee: { label: "计费服务", color: 0x68d391, z: 1, x: 6.2 },
  mq: { label: "消息/MQ", color: 0xf687b3, z: 8, x: 6.2 },
  store: { label: "流水/Redis", color: 0x63b3ed, z: 15, x: 6.2 },
};

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x151a20);

const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 120);
camera.position.set(12, 15, 34);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({
  canvas: document.querySelector("#scene"),
  antialias: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.4, 1);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 12;
controls.maxDistance = 70;
controls.maxPolarAngle = Math.PI * 0.48;
controls.update();

const ambient = new THREE.AmbientLight(0xffffff, 0.62);
scene.add(ambient);
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(8, 18, 8);
scene.add(sun);

const deviceMeshes = new Map();
const coilMeshes = new Map();
const profileObjects = [];
const antennaEndpoints = [];
const labels = [];
let replay = null;
let currentIndex = 0;
let playing = false;
let lastTick = performance.now();
let speed = 1;
let communicationBeam = null;
let coilStates = new Map();
let eventPositions = [];

const coilInfo = {
  "1": { label: "车检器1", profile: "etc", z: -14.5, x: 0, color: 0x6ee7b7 },
  "2": { label: "车检器2", profile: "etc", z: -10.5, x: 0, color: 0x34d399 },
  "6": { label: "存在线圈6", profile: "mtc", z: 11.8, x: 0, color: 0x8bd17c },
  "7": { label: "落杆线圈7", profile: "both", z: 21.5, x: 0, color: 0xa7f3d0 },
};

const deviceZAnchors = {
  vlpr: deviceInfo.vlpr.z,
  axle: deviceInfo.axle.z,
  weigh: deviceInfo.weigh.z,
  cpc: deviceInfo.cpc.z,
  display: deviceInfo.display.z,
  barrier: deviceInfo.barrier.z,
};

const els = {
  select: document.querySelector("#replaySelect"),
  legend: document.querySelector("#legend"),
  play: document.querySelector("#playButton"),
  scrubber: document.querySelector("#scrubber"),
  speed: document.querySelector("#speedSelect"),
  vehicle: document.querySelector("#vehicleName"),
  clock: document.querySelector("#clock"),
  count: document.querySelector("#eventCount"),
  title: document.querySelector("#eventTitle"),
  timeline: document.querySelector("#timeline"),
};

function mat(color, roughness = 0.7) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.08 });
}

function box(w, h, d, color) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
}

function cyl(radiusTop, radiusBottom, height, color, segments = 24) {
  return new THREE.Mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments), mat(color));
}

function makeLabel(text, color = "#eef2f7") {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(12, 16, 22, 0.76)";
  roundRect(ctx, 10, 14, 492, 58, 12);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.font = "32px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 256, 43);
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
  sprite.scale.set(3.4, 0.64, 1);
  labels.push(sprite);
  return sprite;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}

function buildScene() {
  const road = box(5.2, 0.08, 58, 0x2a3038);
  road.position.y = -0.04;
  scene.add(road);

  for (let z = -27; z <= 27; z += 6) {
    const mark = box(0.12, 0.03, 2.7, 0xe9eef5);
    mark.position.set(0, 0.02, z);
    scene.add(mark);
  }

  const shoulderL = box(0.08, 0.04, 58, 0xcfd8e3);
  shoulderL.position.set(-2.65, 0.04, 0);
  scene.add(shoulderL);
  const shoulderR = shoulderL.clone();
  shoulderR.position.x = 2.65;
  scene.add(shoulderR);

  const island = box(1.05, 0.22, 48, 0x4b5563);
  island.position.set(3.25, 0.08, 3.5);
  scene.add(island);
  const islandNose = cyl(0.52, 0.52, 0.2, 0x6b7280, 32);
  islandNose.rotation.x = Math.PI / 2;
  islandNose.position.set(3.25, 0.1, -21.5);
  scene.add(islandNose);
  const islandTail = islandNose.clone();
  islandTail.position.z = 28.5;
  scene.add(islandTail);

  const platform = box(3.8, 0.05, 3.8, 0x46525f);
  platform.position.set(0, 0.04, deviceInfo.weigh.z);
  scene.add(platform);
  profileObjects.push({ object: platform, profiles: new Set(["mtc"]) });

  const tollBooth = new THREE.Group();
  const boothBody = box(1.35, 1.7, 2.2, 0xd7dee8);
  boothBody.position.y = 0.95;
  const boothRoof = box(1.55, 0.18, 2.45, 0x7f8ea3);
  boothRoof.position.y = 1.88;
  const windowA = box(0.05, 0.62, 1.05, 0x7dc4e8);
  windowA.position.set(-0.7, 1.12, 0);
  tollBooth.add(boothBody, boothRoof, windowA);
  tollBooth.position.set(3.25, 0, 5.8);
  scene.add(tollBooth);
  profileObjects.push({ object: tollBooth, profiles: new Set(["mtc"]) });

  Object.entries(coilInfo).forEach(([id, info]) => {
    const group = new THREE.Group();
    const ring = box(1.35, 0.035, 0.9, info.color);
    ring.material.transparent = true;
    ring.material.opacity = 0.48;
    ring.userData.coilId = id;
    ring.position.y = 0.035;
    const center = box(0.9, 0.04, 0.5, 0x1f2933);
    center.position.y = 0.045;
    const label = makeLabel(info.label);
    label.position.set(0, 0.72, 0);
    group.add(ring, center, label);
    group.position.set(info.x, 0, info.z);
    scene.add(group);
    coilMeshes.set(id, { group, body: ring, baseColor: info.color, profile: info.profile, pulse: 0 });
  });

  const detector1 = makePostDevice("车辆检测器1", 0x8bd17c);
  detector1.position.set(-3.25, 0, coilInfo["1"].z);
  scene.add(detector1);
  profileObjects.push({ object: detector1, profiles: new Set(["etc"]) });

  const detector2 = makePostDevice("车辆检测器2", 0x8bd17c);
  detector2.position.set(-3.25, 0, coilInfo["2"].z);
  scene.add(detector2);
  profileObjects.push({ object: detector2, profiles: new Set(["etc"]) });

  const closureDevice = makePostDevice("关道设备", 0x9ca3af);
  closureDevice.position.set(-3.25, 0, -25.2);
  scene.add(closureDevice);

  const frontGantry = makeGantry(-12.4, "前ETC天线", { role: "front", profile: "etc" });
  scene.add(frontGantry);
  profileObjects.push({ object: frontGantry, profiles: new Set(["etc"]) });

  const gantry = makeGantry(deviceInfo.rsu.z, "ETC天线", { deviceKey: "rsu", role: "rear", profile: "both" });
  scene.add(gantry);

  const cameraPost = makePostDevice("车道摄像机", 0x9fb4c8);
  cameraPost.position.set(-3.25, 0, 25.6);
  scene.add(cameraPost);

  const frontIntegrated = makePostDevice("一体化集成设备", 0x9ca3af);
  frontIntegrated.position.set(-3.25, 0, -4.5);
  scene.add(frontIntegrated);
  profileObjects.push({ object: frontIntegrated, profiles: new Set(["etc"]) });

  const rearIntegrated = makePostDevice("一体化集成设备", 0x9ca3af);
  rearIntegrated.position.set(-3.25, 0, 17.1);
  scene.add(rearIntegrated);

  const onlineCoilLabel = makeLabel("存在线圈", "#dbeafe");
  onlineCoilLabel.position.set(2.2, 0.9, 11.8);
  scene.add(onlineCoilLabel);
  profileObjects.push({ object: onlineCoilLabel, profiles: new Set(["mtc"]) });

  communicationBeam = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 3.9, deviceInfo.rsu.z),
      new THREE.Vector3(0, 1.25, -20),
    ]),
    new THREE.LineBasicMaterial({
      color: 0x8ee7ff,
      transparent: true,
      opacity: 0,
      linewidth: 2,
    })
  );
  scene.add(communicationBeam);

  const barrierBase = box(0.45, 0.8, 0.45, 0x313946);
  barrierBase.position.set(2.75, 0.4, deviceInfo.barrier.z);
  scene.add(barrierBase);

  const arm = box(4.1, 0.1, 0.1, 0xeb5757);
  arm.position.set(0.7, 1.08, deviceInfo.barrier.z);
  arm.name = "barrierArm";
  scene.add(arm);

  Object.entries(deviceInfo).forEach(([key, info]) => {
    if (key === "rsu") return;
    const group = new THREE.Group();
    const isService = info.x > 5;
    const body = box(isService ? 1.75 : 0.72, isService ? 0.72 : 0.88, isService ? 1.0 : 0.72, info.color);
    body.position.y = isService ? 1.15 : 0.55;
    group.add(body);
    const label = makeLabel(info.label);
    label.position.set(0, isService ? 2.0 : 1.55, 0);
    group.add(label);
    group.position.set(info.x, 0, info.z);
    scene.add(group);
    if (key === "weigh") {
      profileObjects.push({ object: group, profiles: new Set(["mtc"]) });
    }
    if (key === "cpc") {
      profileObjects.push({ object: group, profiles: new Set(["mtc"]) });
    }
    deviceMeshes.set(key, { group, body, baseColor: info.color, pulse: 0 });
  });

  scene.add(makeVehicle());
  renderLegend();
}

function makeGantry(z, labelText, options = {}) {
  const { deviceKey = null, role = "rear", profile = "both" } = options;
  const gantry = new THREE.Group();
  const postA = box(0.18, 4.2, 0.18, 0x7a8796);
  postA.position.set(-3, 2.1, z);
  const postB = postA.clone();
  postB.position.x = 3;
  const beam = box(6.4, 0.18, 0.18, 0x7a8796);
  beam.position.set(0, 4.1, z);
  const antenna = box(0.9, 0.12, 0.5, 0x56ccf2);
  antenna.position.set(0, 3.75, z);
  const label = makeLabel(labelText, "#d8f7ff");
  label.position.set(0, 4.8, z);
  gantry.add(postA, postB, beam, antenna, label);
  antennaEndpoints.push({ role, profile, mesh: antenna, z });
  if (deviceKey) {
    const info = deviceInfo[deviceKey];
    deviceMeshes.set(deviceKey, { group: antenna, body: antenna, baseColor: info.color, pulse: 0 });
  }
  return gantry;
}

function makePostDevice(labelText, color) {
  const group = new THREE.Group();
  const pole = box(0.14, 1.9, 0.14, 0x7a8796);
  pole.position.y = 0.95;
  const head = box(0.55, 0.45, 0.38, color);
  head.position.y = 1.95;
  const label = makeLabel(labelText);
  label.position.set(0, 2.55, 0);
  group.add(pole, head, label);
  return group;
}

function renderLegend() {
  els.legend.replaceChildren(
    ...Object.entries(deviceInfo).map(([key, info]) => {
      const item = document.createElement("div");
      item.className = "legend-item";
      item.dataset.device = key;
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = `#${info.color.toString(16).padStart(6, "0")}`;
      const label = document.createElement("span");
      label.textContent = info.label;
      item.append(swatch, label);
      return item;
    })
  );
}

function visibleCoilIds(profile) {
  if (profile === "etc") return new Set(["1", "2", "7"]);
  if (profile === "mtc") return new Set(["6", "7"]);
  return new Set(Object.keys(coilInfo));
}

function updateCoilVisibility(profile) {
  const visible = visibleCoilIds(profile);
  coilMeshes.forEach((item, id) => {
    item.group.visible = visible.has(id);
  });
}

function updateProfileVisibility(profile) {
  profileObjects.forEach(({ object, profiles }) => {
    object.visible = profiles.has(profile) || profiles.has("both") || profile === "unknown";
  });
}

function makeVehicle() {
  const car = new THREE.Group();
  const body = box(1.65, 0.65, 3.2, 0x2f80ed);
  body.position.y = 0.58;
  const cab = box(1.35, 0.56, 1.25, 0x56ccf2);
  cab.position.set(0, 1.08, -0.45);
  const obu = box(0.34, 0.12, 0.22, 0xffd166);
  obu.name = "obuUnit";
  obu.position.set(0, 1.42, -0.88);
  const obuLabel = makeLabel("OBU车载单元", "#fff6cc");
  obuLabel.position.set(0, 2.05, -0.9);
  const wheelMat = mat(0x0b0f14);
  [-0.78, 0.78].forEach((x) => {
    [-1.05, 1.05].forEach((z) => {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.18, 18), wheelMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, 0.28, z);
      car.add(wheel);
    });
  });
  car.add(body, cab, obu, obuLabel);
  car.name = "vehicle";
  car.position.set(0, 0, -28);
  return car;
}

function vehicle() {
  return scene.getObjectByName("vehicle");
}

function barrierArm() {
  return scene.getObjectByName("barrierArm");
}

function obuUnit() {
  return scene.getObjectByName("obuUnit");
}

function visibleAntennaEndpoints() {
  if (replay?.laneProfile === "etc") {
    return antennaEndpoints.filter((item) => item.profile === "etc" || item.profile === "both");
  }
  return antennaEndpoints.filter((item) => item.role === "rear");
}

function communicationAntennaForVehicle() {
  const z = vehicle()?.position.z ?? 0;
  const endpoints = visibleAntennaEndpoints();
  return endpoints.reduce((best, item) => {
    if (!best) return item;
    return Math.abs(item.z - z) < Math.abs(best.z - z) ? item : best;
  }, null);
}

function eventZCandidate(event, currentZ) {
  if (event.coilId && coilInfo[event.coilId]) {
    return coilInfo[event.coilId].z;
  }
  if (event.device === "rsu") {
    return replay?.laneProfile === "etc" && currentZ < 0 ? -12.4 : deviceInfo.rsu.z;
  }
  if (Object.hasOwn(deviceZAnchors, event.device)) {
    return deviceZAnchors[event.device];
  }
  return null;
}

function buildEventPositions() {
  let currentZ = -27;
  eventPositions = replay.events.map((event) => {
    const candidate = eventZCandidate(event, currentZ);
    if (candidate !== null) {
      currentZ = Math.max(currentZ, candidate);
    }
    return currentZ;
  });
}

function setEvent(index) {
  if (!replay || !replay.events.length) return;
  currentIndex = Math.max(0, Math.min(index, replay.events.length - 1));
  const event = replay.events[currentIndex];
  const z = eventPositions[currentIndex] ?? -27;
  vehicle().position.z = THREE.MathUtils.lerp(vehicle().position.z, z, 0.55);

  deviceMeshes.forEach((item) => {
    item.pulse = 0;
    item.body.material.emissive = new THREE.Color(0x000000);
  });
  antennaEndpoints.forEach((item) => {
    item.mesh.material.emissive = new THREE.Color(0x000000);
    item.mesh.scale.setScalar(1);
  });
  coilMeshes.forEach((item) => {
    item.pulse = 0;
    item.body.material.emissive = new THREE.Color(0x000000);
    item.body.material.opacity = coilStates.get(item.body.userData.coilId) ? 0.78 : 0.38;
  });
  const active = deviceMeshes.get(event.device) || deviceMeshes.get("service");
  if (event.device === "rsu") {
    const endpoint = communicationAntennaForVehicle();
    if (endpoint) {
      endpoint.mesh.material.emissive = new THREE.Color(deviceInfo.rsu.color).multiplyScalar(1.1);
      endpoint.mesh.scale.setScalar(1.18);
    }
  } else {
    active.pulse = 1;
  }
  if (event.coilId && coilMeshes.has(event.coilId)) {
    const coil = coilMeshes.get(event.coilId);
    if (typeof event.coilState === "boolean") {
      coilStates.set(event.coilId, event.coilState);
    }
    coil.pulse = 1;
    coil.group.visible = true;
    coil.body.material.opacity = event.coilState === false ? 0.38 : 0.88;
  }
  communicationBeam.userData.active = event.device === "rsu";
  [...els.legend.children].forEach((item) => {
    item.classList.toggle("active", item.dataset.device === event.device);
  });

  const arm = barrierArm();
  if (event.kind === "success") {
    arm.rotation.z = THREE.MathUtils.degToRad(26);
  } else if (event.kind === "reject") {
    arm.rotation.z = 0;
  }

  els.scrubber.value = currentIndex;
  els.clock.textContent = event.time.slice(11, 23);
  els.count.textContent = `${currentIndex + 1} / ${replay.events.length}`;
  updateTimelineActive();
}

function renderTimeline() {
  els.timeline.replaceChildren(
    ...replay.events.map((event, index) => {
      const li = document.createElement("li");
      li.dataset.index = index;
      const time = document.createElement("div");
      time.className = "time";
      time.textContent = event.time.slice(11, 23);
      const summary = document.createElement("div");
      summary.className = "summary";
      summary.textContent = event.raw;
      li.append(time, summary);
      li.addEventListener("click", () => {
        playing = false;
        els.play.textContent = "播放";
        setEvent(index);
      });
      return li;
    })
  );
}

function updateTimelineActive() {
  [...els.timeline.children].forEach((li, index) => {
    li.classList.toggle("active", index === currentIndex);
    if (index === currentIndex) li.scrollIntoView({ block: "nearest" });
  });
}

async function loadIndex() {
  const response = await fetch("./data/index.json");
  const index = await response.json();
  els.select.replaceChildren(
    ...index.map((item) => {
      const option = document.createElement("option");
      option.value = item.file;
      option.textContent = `${item.vehicle}  ${item.start.slice(11, 19)}  ${item.eventCount}条`;
      return option;
    })
  );
  const requestedFile = new URLSearchParams(window.location.search).get("file");
  const initialFile = index.some((item) => item.file === requestedFile)
    ? requestedFile
    : index[0]?.file;
  if (initialFile) {
    els.select.value = initialFile;
    await loadReplay(initialFile);
  }
}

async function loadReplay(file) {
  const response = await fetch(`./data/${file}`);
  replay = await response.json();
  currentIndex = 0;
  coilStates = new Map();
  els.vehicle.textContent = replay.vehicle;
  els.title.textContent = replay.passageTitle || `${replay.vehicle} ${replay.events[0]?.time?.slice(0, 19) || ""}`;
  els.scrubber.max = String(Math.max(replay.events.length - 1, 0));
  updateProfileVisibility(replay.laneProfile);
  updateCoilVisibility(replay.laneProfile);
  buildEventPositions();
  renderTimeline();
  setEvent(0);
}

function resize() {
  const rect = renderer.domElement.parentElement.getBoundingClientRect();
  renderer.setSize(rect.width, rect.height, false);
  camera.aspect = rect.width / Math.max(rect.height, 1);
  camera.updateProjectionMatrix();
}

function animate(now) {
  requestAnimationFrame(animate);
  const dt = (now - lastTick) / 1000;
  lastTick = now;

  if (playing && replay?.events.length) {
    const next = currentIndex + Math.max(1, Math.floor(speed * dt * 2));
    if (next >= replay.events.length) {
      playing = false;
      els.play.textContent = "播放";
      setEvent(replay.events.length - 1);
    } else {
      setEvent(next);
    }
  }

  deviceMeshes.forEach((item) => {
    item.pulse = Math.max(0, item.pulse - dt * 1.6);
    const intensity = item.pulse * 0.95;
    item.body.material.emissive = new THREE.Color(item.baseColor).multiplyScalar(intensity);
    item.group.scale.setScalar(1 + item.pulse * 0.12);
  });

  coilMeshes.forEach((item) => {
    item.pulse = Math.max(0, item.pulse - dt * 1.8);
    const intensity = item.pulse * 1.2;
    item.body.material.emissive = new THREE.Color(item.baseColor).multiplyScalar(intensity);
    item.group.scale.setScalar(1 + item.pulse * 0.18);
  });

  if (communicationBeam) {
    const active = communicationBeam.userData.active;
    const targetOpacity = active ? 0.88 : 0;
    communicationBeam.material.opacity = THREE.MathUtils.lerp(
      communicationBeam.material.opacity,
      targetOpacity,
      0.16
    );
    communicationBeam.visible = communicationBeam.material.opacity > 0.02;
    if (communicationBeam.visible) {
      const obuPosition = new THREE.Vector3();
      obuUnit()?.getWorldPosition(obuPosition);
      const endpoint = communicationAntennaForVehicle();
      const antennaPosition = new THREE.Vector3(0, 3.9, deviceInfo.rsu.z);
      if (endpoint) {
        endpoint.mesh.getWorldPosition(antennaPosition);
        endpoint.mesh.material.emissive = new THREE.Color(deviceInfo.rsu.color).multiplyScalar(0.95);
        endpoint.mesh.scale.setScalar(1.14);
      }
      const points = [
        antennaPosition,
        obuPosition,
      ];
      communicationBeam.geometry.setFromPoints(points);
    }
  }

  labels.forEach((label) => label.lookAt(camera.position));
  controls.update();
  renderer.render(scene, camera);
}

els.play.addEventListener("click", () => {
  playing = !playing;
  els.play.textContent = playing ? "暂停" : "播放";
});

els.scrubber.addEventListener("input", () => {
  playing = false;
  els.play.textContent = "播放";
  setEvent(Number(els.scrubber.value));
});

els.speed.addEventListener("change", () => {
  speed = Number(els.speed.value);
});

els.select.addEventListener("change", () => {
  playing = false;
  els.play.textContent = "播放";
  loadReplay(els.select.value);
});

window.addEventListener("resize", resize);
buildScene();
resize();
loadIndex().catch((error) => {
  els.title.textContent = "数据加载失败";
  els.timeline.replaceChildren();
  const item = document.createElement("li");
  const time = document.createElement("div");
  time.className = "time";
  time.textContent = "error";
  const summary = document.createElement("div");
  summary.className = "summary";
  summary.textContent = String(error);
  item.append(time, summary);
  els.timeline.append(item);
});
requestAnimationFrame(animate);
