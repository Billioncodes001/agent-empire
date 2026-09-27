import { OfficeSound } from './sound';
/** Developer review surface, deliberately excluded from the production build entries. */
import './style.css';
import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { buildCity } from './world/city';
import { buildOffice } from './world/office';
import { Person } from './world/character';
import { PlayerController } from './player';
import { Tower } from './tower';
import { applyGraphics } from './graphics';
import { Traversal } from './traversal';
import { store } from './state';
import { lookFromSeed } from '../shared/avatar';
import { initialEmpire } from '../shared/empire';
import { mountEmpire } from './ui/empire';
import { onModalChange } from './ui/dom';
import type { Net } from './net';
if (!import.meta.env.DEV) throw new Error('Graphics review is development-only');
const css = document.createElement('style');
css.textContent =
  '#review{position:absolute;right:18px;bottom:20px;width:255px;background:#15232ae8;color:#e7e9df;padding:18px;font:12px system-ui;border-radius:8px}#review strong{font-size:10px;letter-spacing:.14em}#review p{font-size:10px;opacity:.65;line-height:1.6}#scenarios{display:flex;gap:6px;flex-wrap:wrap}#scenarios button{font:11px system-ui;background:#ffffff12;color:white;border:1px solid #ffffff28;padding:8px;border-radius:4px;cursor:pointer}#review label{display:flex;align-items:center;gap:8px;margin:14px 0}#telemetry{font:10px monospace;display:block;white-space:pre-line}';
document.head.append(css);
const canvas = document.getElementById('scene') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.info.autoReset = false;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#bed0dd');
scene.fog = new THREE.Fog('#bdcad0', 140, 430);
const camera = new THREE.PerspectiveCamera(64, innerWidth / innerHeight, 0.08, 1500);
scene.add(new THREE.HemisphereLight('#d8e7f3', '#6a6250', 0.55));
const sun = new THREE.DirectionalLight('#fff1db', 3.2);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 100 });
sun.shadow.bias = -0.00008;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);
const pmrem = new THREE.PMREMGenerator(renderer);
new HDRLoader().load('/textures/coastal-sky.hdr', (hdr) => {
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = hdr;
  scene.backgroundIntensity = 0.85;
  scene.environment = pmrem.fromEquirectangular(hdr).texture;
  scene.environmentIntensity = 0.7;
  pmrem.dispose();
});
const office = buildOffice(),
  city = buildCity();
scene.add(office.group, city.group);
office.group.add(city.chief);
office.colliders.push(...city.colliders);
store.empire = initialEmpire();
store.empire.office = { floors: 3, workstations: 36 };
store.empire.setup.completed = true;
office.setFloor(0, 36);
store.empire.sectors.forEach((s) => (s.built = true));
city.sync(store.empire);
const player = new PlayerController(camera, canvas, office.colliders);
player.view = 'third';
const person = new Person('Founder', '#75898b', { ...lookFromSeed('founder'), style: 0 });
person.showLabel(false);
scene.add(person.root);
const sound = new OfficeSound(); sound.setVolume(.7, false);
const traversal = new Traversal(player, person, office, city, () => (store.empire.delegated = true), (cue, at) => sound.carCue(cue, at));
const tower = new Tower({ send: () => {} } as unknown as Net, player, office, () => {});
const empire = mountEmpire({ send: () => {} } as unknown as Net, player, () => {});
onModalChange((open) => {
  player.enabled = !open;
  player.clearKeys();
});
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const ao = new SSAOPass(scene, camera, innerWidth, innerHeight);
ao.kernelRadius = 0.55;
ao.minDistance = 0.001;
ao.maxDistance = 0.075;
composer.addPass(ao);
composer.addPass(new OutputPass());
applyGraphics('high', renderer, composer, ao, sun, scene); city.setQuality('high');
let scenario = 'Street',
  walking = false,
  elapsed = 0;
const playback = document.getElementById('playback') as HTMLInputElement;
function setup(name: string) {
  if (player.scripted) return;
  office.setFloor(0, 36);
  person.pose = 'stand';
  store.emit('empire');
  scenario = name;
  walking = false;
  elapsed = 0;
  player.clearKeys();
  player.driving = false;
  player.speed = 0;
  player.vy = 0;
  player.stepOffset = 0;
  player.setView('third');
  player.camDist = 4.6;
  player.camPitch = 0.16;
  player.camYaw = Math.PI;
  player.facing = 0;
  player.pos.set(-9.4, 0, 56);
  city.car.position.set(5, 0, 45);
  city.car.rotation.y = 0;
  if (name === 'Walk' || name === 'Run') {
    player.pos.set(-9.4, 0, 72);
    player.camYaw = Math.PI;
    player.setAction('forward', true);
    player.setAction('run', name === 'Run');
    walking = true;
  }
  if (name === 'Elevator') {
    player.pos.set(7, 0, -5.9); player.camYaw = 0; player.facing = Math.PI;
  }
  if (name === 'Typing') {
    player.pos.set(-11.6, 0, -5.5); player.camYaw = Math.PI * .72; player.camDist = 2.9; player.camPitch = .35;
    person.pose = 'type'; player.facing = 0;
  }
  if (name === 'Office') {
    player.pos.set(0, 0, 8);
    player.camYaw = Math.PI;
  }
  if (name === 'Walk out') {
    player.pos.set(0, 0, 10);
    player.camYaw = Math.PI;
    player.setAction('forward', true);
    walking = true;
  }
  if (name === 'Walk in') {
    player.pos.set(-21.8, 0, 56.5);
    player.camYaw = 0;
    player.facing = Math.PI;
    player.setAction('forward', true);
    walking = true;
  }
  if (name === 'Enter car') {
    player.pos.set(3.2, 0, 45.1);
    traversal.interactCar();
  }
  if (name === 'Residence') {
    player.pos.set(24, 0, 50);
    player.camYaw = 0;
  }
  if (name === 'Recreation') {
    player.pos.set(-22,0,144); player.camYaw=0; player.facing=Math.PI;
  }
  if (name === 'District') {
    player.pos.set(2, 0, 77);
    player.camYaw = 0.65;
    player.camDist = 125;
    player.camPitch = 0.85;
  }
  if (name === 'First person') {
    player.pos.set(-9.4, 0, 56);
    player.setView('first');
    player.camYaw = Math.PI;
  }
  player.updateCamera(true);
}
for (const name of [
  'Street',
  'Walk',
  'Run',
  'Office',
  'Elevator',
  'Typing',
  'Walk out',
  'Walk in',
  'Enter car',
  'Exit car',
  'Residence',
  'Recreation',
  'District',
  'First person',
  'Driver view',
  'Accelerate', 'Brake', 'Coast', 'Steer left', 'Steer right', 'Straight', 'Car detail', 'Entry pose',
]) {
  const button = document.createElement('button');
  button.textContent = name;
  button.onclick = () => {
    if (name === 'Entry pose') {
      if (player.scripted) return;
      setup('Enter car');
      for (let i=0;i<174;i++) {
        const dt=1/60; player.update(dt); traversal.update(dt);
        person.root.position.copy(player.pos); person.root.rotation.y=player.facing;
        person.update(dt, i*dt, player.moving, false, player.speed);
      }
      playback.value='0';
    } else if (['Accelerate', 'Brake', 'Coast', 'Steer left', 'Steer right', 'Straight'].includes(name)) {
      if (!player.driving) return;
      if (['Accelerate', 'Brake', 'Coast'].includes(name)) { player.setAction('forward', name === 'Accelerate'); player.setAction('backward', name === 'Brake'); }
      else { player.setAction('left', name === 'Steer left'); player.setAction('right', name === 'Steer right'); }
    } else if (name === 'Car detail') {
      if (player.driving) { player.camYaw = city.car.rotation.y - Math.PI * .65; player.camDist = 5.3; player.camPitch = .22; player.setView('third'); player.updateCamera(true); }
      else { setup('Street'); player.pos.set(3.3,0,45.1); player.camYaw=-Math.PI*.6; player.camDist=4.3; player.updateCamera(true); }
    } else if (name === 'Exit car') {
      if (player.driving) traversal.interactCar();
    } else if (name === 'Driver view') {
      if (player.driving) player.setView('first');
    } else setup(name);
  };
  document.getElementById('scenarios')!.append(button);
}
const resize = () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
};
window.addEventListener('resize', resize);
resize();
setup('Street');
let lastStride = 0;
let last = 0,
  time = 0;
renderer.setAnimationLoop((now) => {
  renderer.info.reset();
  const dt = Math.min((now - last) / 1000, 0.05) * Number(playback.value);
  last = now;
  time += dt;
  elapsed += dt;
  if (walking && (elapsed > 7 || (scenario === 'Walk out' && player.pos.z >= 30) || (scenario === 'Walk in' && player.pos.z < 30))) {
    player.clearKeys();
    walking = false;
  }
  player.update(dt);
  if (!tower.active && scenario !== 'Typing') traversal.update(dt);
  tower.update(dt);
  city.update(time, dt, player.pos, player.driving);
  empire.update(dt);
  if (player.driving) {
    city.car.position.copy(player.pos);
    city.car.rotation.y = player.facing;
  }
  const outside = player.pos.z >= 30;
  city.animateCar(dt, player.vehicle, player.driving);
  sound.environment(outside);
  sound.vehicle(player.vehicle, player.driving, city.car.position, player.view === 'first');
  const look = camera.getWorldDirection(new THREE.Vector3());
  sound.update({ x: player.pos.x, y: player.pos.y + 1.66 - (outside ? 0 : office.group.position.y), z: player.pos.z, fx: look.x, fz: look.z });
  const stride = Math.floor(player.walkPhase / Math.PI);
  if (stride !== lastStride && player.moving && player.grounded && !player.driving) sound.step('walk', player.speed > 2.5);
  lastStride = stride;
  canvas.dataset.audio = sound.recordings;
  canvas.dataset.foley = JSON.stringify(sound.foleyPlayed);
  canvas.dataset.speed = player.drivingSpeed.toFixed(2);

  office.group.visible = !outside;
  city.group.visible = outside;
  sun.position.set(player.pos.x - 24, player.pos.y + 40, player.pos.z + 24);
  sun.target.position.set(player.pos.x, player.pos.y, player.pos.z);
  sun.target.updateMatrixWorld();
  person.root.position.copy(player.pos);
  person.root.rotation.y = player.facing;
  person.update(dt, time, player.moving && !player.driving, !player.grounded, player.speed);
  traversal.placeDriver();
  person.root.visible = player.view === 'third';
  canvas.dataset.assets = person.ready && city.car.userData.ready && scene.environment ? 'ready' : 'loading';
  canvas.dataset.position = player.pos
    .toArray()
    .map((v) => v.toFixed(2))
    .join(',');
  canvas.dataset.traversal = tower.active ? 'elevator' : traversal.state;
  canvas.dataset.floor = String(office.floor + 1);
  composer.render();
  document.getElementById('telemetry')!.textContent =
    `${scenario} · ${canvas.dataset.traversal} · Floor ${office.floor + 1}\n${canvas.dataset.position}\n${person.root.children[0]?.userData.motion ?? 'loading'} · ${renderer.info.render.calls} draws\nAudio ${sound.recordings} · ${(Math.abs(player.drivingSpeed)*3.6).toFixed(0)} km/h · ${player.vehicle.rpm.toFixed(0)} rpm`;
});
