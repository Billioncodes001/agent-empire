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
store.empire.sectors.forEach((s) => (s.built = true));
city.sync(store.empire);
const player = new PlayerController(camera, canvas, office.colliders);
player.view = 'third';
const person = new Person('Founder', '#75898b', { ...lookFromSeed('founder'), style: 0 });
person.showLabel(false);
scene.add(person.root);
const traversal = new Traversal(player, person, office, city, () => (store.empire.delegated = true));
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
let scenario = 'Street',
  walking = false,
  elapsed = 0;
const playback = document.getElementById('playback') as HTMLInputElement;
function setup(name: string) {
  if (player.scripted) return;
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
    player.camDist = 75;
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
  'Walk out',
  'Walk in',
  'Enter car',
  'Exit car',
  'Residence',
  'Recreation',
  'District',
  'First person',
  'Driver view',
]) {
  const button = document.createElement('button');
  button.textContent = name;
  button.onclick = () => {
    if (name === 'Exit car') {
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
let last = 0,
  time = 0;
renderer.setAnimationLoop((now) => {
  const dt = Math.min((now - last) / 1000, 0.05) * Number(playback.value);
  last = now;
  time += dt;
  elapsed += dt;
  if (walking && (elapsed > 7 || (scenario === 'Walk out' && player.pos.z >= 30) || (scenario === 'Walk in' && player.pos.z < 30))) {
    player.clearKeys();
    walking = false;
  }
  player.update(dt);
  traversal.update(dt);
  city.update(time, store.empire.delegated, dt, player.pos, player.driving);
  empire.update(dt);
  if (player.driving) {
    city.car.position.copy(player.pos);
    city.car.rotation.y = player.facing;
  }
  const outside = player.pos.z >= 30;
  office.group.visible = !outside;
  city.group.visible = outside;
  sun.position.set(player.pos.x - 24, 40, player.pos.z + 24);
  sun.target.position.set(player.pos.x, 0, player.pos.z);
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
  canvas.dataset.traversal = traversal.state;
  document.getElementById('telemetry')!.textContent =
    `${scenario} · ${traversal.state}\n${canvas.dataset.position}\n${person.root.children[0]?.userData.motion ?? 'loading'} · ${renderer.info.render.calls} draws`;
  composer.render();
});
