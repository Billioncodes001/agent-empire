// First, so the splash counts every file the scene requests.
import './ui/loading';
import { Traversal } from './traversal';
import { openFounding } from './ui/founding';
import { buildCity } from './world/city';
import { mountEmpire } from './ui/empire';
import { officeCode, DEFAULT_KEYS, keyLabel, type Action } from './controls';
import './style.css';
import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { sameLook } from '../shared/avatar';
import { DESK_BY_ID, FLOOR_RISE, SPAWN, deskSeat } from '../shared/layout';
import type { PeerInfo, WorkerInfo } from '../shared/protocol';
import { Net } from './net';
import { apiFetch } from './endpoint';
import { store, loadProfile, loadSettings, saveSettings, type Profile } from './state';
import { EYE_HEIGHT, PlayerController, groundAt, isTyping } from './player';
import { buildOffice, type InteractKind, type Interactable } from './world/office';
import { Person, Worker } from './world/character';
import { OfficeLife } from './world/worker-life';
import type { WaitingOn } from './world/routines';
import { Laptop } from './world/laptop';
import { BoardTexture, QueueBoardTexture, ServicesBoardTexture } from './world/boards';
import { Gallery } from './world/gallery';
import { Hanger } from './hanging';
import { disposeSprite, textSprite } from './world/toon';
import { Voice } from './voice';
import { OfficeSound } from './sound';
import { $, h, closeAllModals, modalOpen, onModalChange, openModal, toast, STATUS_LABEL } from './ui/dom';
import { openTerminal, openTerminalFor, routeTerminalMessage } from './ui/terminal';
import { openChanges, openChangesFor, routeChangesMessage } from './ui/changes';
import { openPrompt, confirmDialog, sendHomeDialog, routeWorktreeMessage } from './ui/prompt';
import { openBoard } from './ui/boards';
import { openPull, routePullMessage } from './ui/pull';
import { openAsk } from './ui/ask';
import { openTeam, routeTeamMessage } from './ui/team';
import { mountServicesButton, openServices } from './ui/services';
import { mountQueueButton, openQueue } from './ui/queue';
import { openUpgrade, restarting, showRestarting, showUpgraded } from './ui/upgrade';
import { openHelp, openWorkersDialog, renderChat, renderPeople, renderWorkers, updateSpeaking } from './ui/hud';
import { mountStatusStrip } from './ui/status-strip';
import { typingPose } from './ui/status';
import { openCharacter } from './ui/character';
import { Tower } from './tower';
import { GRAPHICS, applyGraphics } from './graphics';
import { openSettings } from './ui/settings';
import { appPanel } from './ui/app-panel';
import { startUpdates, updateSettingsSection } from './update';
import { connectionView } from './ui/continuity';
import { setupPwa } from './ui/pwa';
import { maybeOfferExecutionSetup, openCloudTasks, openExecutionSetup } from './ui/execution';
import { cloudSession, forgetSavedSnapshots } from './cloud/session';
import { CloudNet } from './cloud/net';
import { installCloudChrome, mountCloudStrip, openCloudPanel } from './cloud/ui';
import { native } from './native';
import { hiringPaused, renderUsage, usageLabel, usageTitle } from './ui/usage';

// ---- Renderer & scene ---------------------------------------------------------------------------
const canvas = $('scene') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.info.autoReset=false;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;


const scene = new THREE.Scene();
scene.background = new THREE.Color('#bed0dd');
scene.fog = new THREE.Fog('#bdcad0', 140, 430);
const camera = new THREE.PerspectiveCamera(64, 1, 0.08, 1500);

scene.add(new THREE.HemisphereLight('#d8e7f3', '#6a6250', .55));
const sun = new THREE.DirectionalLight('#fff1db', 3.2);
sun.position.set(-8, 18, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 100 });
sun.shadow.bias = -0.00008;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);
// The sky is also the image-based lighting every PBR material needs; without it skin and clothes go dark.
// A failed download is retried twice. The splash waits for it (data-assets below), and if it only arrives after a
// player chose "Enter anyway", three.js sees the new scene.environment and rebuilds the affected programs itself.
function loadSky(attempt = 0) {
  new HDRLoader().load('/textures/coastal-sky.hdr', hdr => {
    const environment = new THREE.PMREMGenerator(renderer);
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = hdr;
    scene.backgroundIntensity = .85;
    scene.environment = environment.fromEquirectangular(hdr).texture;
    scene.environmentIntensity = .7;
    environment.dispose();
  }, undefined, error => {
    console.warn('HDR sky unavailable', error);
    if (attempt < 2) window.setTimeout(() => loadSky(attempt + 1), 1500 * (attempt + 1));
  });
}
loadSky();
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const ao = new SSAOPass(scene, camera, window.innerWidth, window.innerHeight);
ao.kernelRadius = .55;
ao.minDistance = .001;
ao.maxDistance = .075;
composer.addPass(ao);
composer.addPass(new OutputPass());

const office = buildOffice();
scene.add(office.group);
const city = buildCity();
scene.add(city.group);
office.group.add(city.chief);
office.colliders.push(...city.colliders);
store.on('empire', () => city.sync(store.empire));
city.sync(store.empire);

const noOutline = (obj: THREE.Object3D) =>
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const geo = m.geometry;
    const flat = geo instanceof THREE.PlaneGeometry || geo instanceof THREE.CircleGeometry;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) if (flat || mat instanceof THREE.MeshBasicMaterial) mat.userData.outlineParameters = { visible: false };
  });
noOutline(office.group);

// Boards
const issuesTex = new BoardTexture('issues');
const pullsTex = new BoardTexture('pulls');
for (const [meshKey, tex] of [
  ['issues', issuesTex],
  ['pulls', pullsTex],
] as const) {
  const mat = office.boardMeshes[meshKey].material as THREE.MeshBasicMaterial;
  mat.map = tex.texture;
  mat.needsUpdate = true;
}
store.on('issues', () => issuesTex.render(store.issues));
store.on('pulls', () => pullsTex.render(store.pulls, store.workers));
issuesTex.render(store.issues);
pullsTex.render(store.pulls, store.workers);
// PR notes name the desk they came from. Redraw when that changes, not on every worker update.
let deskLinks = '';
store.on('workers', () => {
  const k = JSON.stringify([...store.workers.values()].filter((w) => w.worktree).map((w) => [w.worktree!.branch, w.pr?.number, w.name, w.color, w.deskId]));
  if (k === deskLinks) return;
  deskLinks = k;
  pullsTex.render(store.pulls, store.workers);
});
const servicesTex = new ServicesBoardTexture();
const servicesMat = office.boardMeshes.services.material as THREE.MeshBasicMaterial;
servicesMat.map = servicesTex.texture;
servicesMat.needsUpdate = true;
const renderServicesBoard = () => servicesTex.render(store.services.items, store.workers);
store.on('services', renderServicesBoard);
store.on('workers', renderServicesBoard);
renderServicesBoard();
const queueTex = new QueueBoardTexture();
const queueMat = office.boardMeshes.queue.material as THREE.MeshBasicMaterial;
queueMat.map = queueTex.texture;
queueMat.needsUpdate = true;
const renderQueueBoard = () => queueTex.render(store.queue, store.workers);
store.on('queue', renderQueueBoard);
store.on('workers', renderQueueBoard);
renderQueueBoard();

// Pictures people hung on the walls
const gallery = new Gallery();
office.group.add(gallery.group);
store.on('decor', () => gallery.sync(store.decor));

// TV
const tvVideo = document.createElement('video');
tvVideo.muted = true;
tvVideo.playsInline = true;
tvVideo.autoplay = true;
const tvTexture = new THREE.VideoTexture(tvVideo);
tvTexture.colorSpace = THREE.SRGBColorSpace;
const tvIdle = (() => {
  const c = document.createElement('canvas');
  c.width = 1280;
  c.height = 720;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 1280, 720);
  grad.addColorStop(0, '#172b31');
  grad.addColorStop(1, '#45665e');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1280, 720);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.font = '500 78px system-ui, sans-serif';
  g.fillText('AGENT EMPIRE', 640, 330);
  g.font = '400 36px system-ui, sans-serif';
  g.fillText('Click “Share screen” to put something up here', 640, 420);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
const tvMat = office.tvScreen.material as THREE.MeshBasicMaterial;
tvMat.color.set('#ffffff');
tvMat.map = tvIdle;
tvMat.toneMapped = false;

// ---- Networking & state -------------------------------------------------------------------------
// Cloud mode (CLOUD-04): the Empire lives in the user's GitHub; the same store is fed from its committed snapshots.
const cloud = cloudSession();
const cloudNet = cloud ? new CloudNet(cloud, () => store.profile) : null;
const net: Net = cloudNet ?? new Net(() => store.profile);
const voice = new Voice(net);

const me = new Person(store.profile.name, store.profile.color, store.profile.look);
me.showLabel(false);
scene.add(me.root);
noOutline(me.root);
const settings = loadSettings();
applyGraphics(settings.quality, renderer, composer, ao, sun, scene);
city.setQuality(settings.quality);
const player = new PlayerController(camera, canvas, office.colliders);
player.pos.set(SPAWN.x, 0, SPAWN.z);
player.view = settings.view;
player.bindings = settings.keys;
const sound = new OfficeSound();
sound.setVolume(settings.volume, settings.muted);
const empireUI = mountEmpire(net,player,()=>showQueue(),()=>{if(!traversal.interactCar()&&!empireUI.interact())use(target,'E');},()=>changeView(),(id)=>openWorkerTerminal(id));
if (cloudNet) {
  mountCloudStrip($('status-strip'), cloudNet, (tab) => openCloudPanel(cloudNet, tab));
  installCloudChrome(cloudNet, {
    forgetDevice: () => {
      cloudNet.stop();
      forgetSavedSnapshots();
      const bridge = native();
      void Promise.allSettled(['github.token', 'github.login', 'mode', 'state.repo'].map((k) => bridge.secureDelete(k as 'mode'))).then(() => location.reload());
    },
  });
} else mountStatusStrip($('status-strip'), { openManagement: () => empireUI.openOperations(), openWorkers: () => openWorkersDialog(openWorkerTerminal) });
// In-app updates (REL-03/05): the prompt waits for a calm moment (never mid-jump, typing or in a dialog).
const updateService = startUpdates({ airborne: () => !player.grounded, cloudRepo: cloudNet?.repo ?? null });
const traversal = new Traversal(player,me,office,city,()=>{
  if(!store.empire.delegated)net.send({t:'empire.action',action:{kind:'delegate',enabled:true}});
}, (cue, at) => sound.carCue(cue, at));
function paintViewButton() {
  const next = player.view === 'third' ? 'First person' : 'Third person';
  const button = $('btn-camera');
  button.textContent = next;
  button.setAttribute('aria-label', `Switch to ${next.toLowerCase()}`);
  button.title = `${next} (${keyLabel(settings.keys.camera)})`;
}
paintViewButton();
$('btn-camera').addEventListener('click', () => { changeView(); canvas.focus(); });
function changeView() {
  player.setView(player.view==='first'?'third':'first');
  if(player.view==='third'){player.camDist=player.driving?7:4.6;player.camPitch=.16;}
  settings.view=player.view;saveSettings(settings);
  paintViewButton();
}
const hanger = new Hanger(net, camera, canvas, player, office, gallery);
scene.add(hanger.ghost.group);
hanger.onChange = () => {
  const b = $('btn-decor');
  b.classList.toggle('on', hanger.active);
  b.title = hanger.active ? 'Stop hanging the picture (Esc)' : 'Hang a picture on a wall (F)';
  // Not '': that reads as "no hint shown", and the hanging hint would stay up.
  hintKey = 'stale';
};

function showMyProfile(p: Profile) {
  me.setColor(p.color);
  me.setLook(p.look);
}

interface RemotePeer {
  person: Person;
  target: THREE.Vector3;
  rotY: number;
  moving: boolean;
  label: string;
  look: PeerInfo['look'];
  bubble?: { sprite: THREE.Sprite; until: number };
  /** Seconds walked since their last footstep. */
  stepT: number;
}
const remotes = new Map<string, RemotePeer>();

interface WorkerView {
  model: Worker;
  laptop: Laptop;
  deskId: string;
  status: string;
  acked: boolean;
}
const workerViews = new Map<string, WorkerView>();
// Worker routines (LIFE-03): desk ↔ amenities from real server state only. Reduced motion places bodies without walking.
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const life = new OfficeLife(office, {
  reducedMotion: () => reducedMotion.matches,
  detail: () => settings.quality !== 'low',
  onTyping: (id, typing) => { const w = store.workers.get(id), d = w && DESK_BY_ID.get(w.deskId); if (d) sound.setTyping(id, d.x, d.z, typing); },
});
let firstWelcome = true;
let foundingOpened = false;
/** The server version this page was loaded with. */
let bootVersion = '';
let upgradePhase = '';

net.onStatus((up) => {
  store.setConnected(up);
  renderConnection();
  // The host may not offer continuity yet; the socket can also push it.
  if (up && !cloudNet)
    apiFetch('/api/continuity/status', { cache: 'no-store', credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => store.setContinuity(body))
      .catch(() => {});
});
function renderConnection() {
  const view = connectionView({ online: store.online, connected: store.connected, cloud: !!cloudNet });
  const down = !store.online || !store.connected;
  $('conn').classList.toggle('hidden', !down);
  $('conn').classList.toggle('offline', !store.online);
  $('conn-text').textContent = view.label;
  $('conn').title = view.detail;
  $('conn-retry').classList.toggle('hidden', !store.online);
}
store.on('connection', renderConnection);
$('conn-retry').addEventListener('click', () => net.reconnectNow());
window.addEventListener('online', () => {
  store.setOnline(true);
  net.reconnectNow();
});
window.addEventListener('offline', () => store.setOnline(false));
setupPwa();

let executionOfferChecked = false;
function offerExecutionWhenFree() {
  // Waits for character and founding to finish; retried whenever the last dialog closes.
  if (cloudNet || executionOfferChecked || !store.empire.setup.completed || modalOpen()) return;
  executionOfferChecked = true;
  const openSetup = (): void => void openExecutionSetup({ openTasks: () => openCloudTasks({ openSetup }) });
  void maybeOfferExecutionSetup(openSetup);
}
onModalChange((open) => {
  if (!open) setTimeout(offerExecutionWhenFree, 0);
});
net.onMessage((msg) => {
  if (msg.t === 'welcome') voice.reset();
  store.apply(msg);
  routeTerminalMessage(msg);
  routeChangesMessage(msg);
  routeTeamMessage(msg);
  routePullMessage(msg);
  switch (msg.t) {
    case 'empire':
      if (!msg.state.setup.completed && !foundingOpened) { foundingOpened = true; openFounding(net); }
      offerExecutionWhenFree();
      break;
    case 'welcome': {
      const mine = store.peers.get(store.you);
      if (firstWelcome && mine) {
        player.pos.set(mine.x, 0, mine.z);
        firstWelcome = false;
      }
      if (voice.inVoice || voice.sharing) net.send({ t: 'voice', voice: voice.inVoice, muted: voice.muted, sharing: voice.sharing });
      // After a reconnect the server has forgotten which terminal we had open.
      const openId = openTerminalFor();
      if (openId && store.workers.has(openId)) net.send({ t: 'worker.attach', workerId: openId });
      const watching = openChangesFor();
      if (watching && store.workers.has(watching)) net.send({ t: 'changes.watch', workerId: watching });
      renderProject();
      $('btn-team').classList.toggle('hidden', !store.invites);
      // Back from a restart on another version: this page's code is stale, so load the new one.
      updateService.setServerVersion(msg.appVersion ?? msg.version);
      if (!bootVersion) bootVersion = msg.version;
      else if (msg.version !== bootVersion || restarting()) showUpgraded(msg.upgrade);
      upgradePhase = msg.upgrade.phase;
      voice.syncPeers();
      break;
    }
    case 'peer.join':
    case 'peer.leave':
      voice.syncPeers();
      break;
    case 'rtc':
      void voice.handleSignal(msg.from, msg.data as never);
      break;
    case 'worker.worktree':
      routeWorktreeMessage(msg);
      break;
    case 'toast':
      toast(msg.text, msg.level);
      break;
    case 'upgrade':
      if (msg.state.phase === 'restarting') showRestarting(msg.state, net);
      if (msg.state.phase === 'failed' && upgradePhase === 'building') toast(`The upgrade failed, so the office stays on ${msg.state.current?.sha ?? 'this version'}`, 'error');
      upgradePhase = msg.state.phase;
      break;
    case 'chat':
      sayBubble(msg.from, msg.text);
      break;
    case 'peer.act':
      remotes.get(msg.id)?.person.reach();
      break;
  }
});

function renderUpgrade() {
  const u = store.upgrade;
  const btn = $('btn-upgrade');
  btn.classList.toggle('hidden', !u.available);
  btn.classList.toggle('primary', !!u.latest && u.phase !== 'building');
  btn.textContent = u.phase === 'building' ? '🛠️ Upgrading…' : u.latest ? '⬆️ Update' : '⬆️';
  btn.title = u.latest ? `New version: ${u.latest.subject}` : 'Upgrade the office';
  const banner = $('upgrade-banner');
  banner.classList.toggle('hidden', u.phase !== 'building');
  banner.textContent = `🛠️ ${u.by ?? 'Someone'} is upgrading the office. It restarts on the new version in a minute or two.`;
}
store.on('upgrade', renderUpgrade);

function renderProject() {
  const p = store.project;
  if (!p) return;
  $('project-name').textContent = `🏢 ${p.name}`;
  $('project-meta').textContent = [p.branch && `⎇ ${p.branch}`, p.dir, `runs: ${p.agentCmd}`].filter(Boolean).join(' · ');
  document.title = `${p.name} · Agent Office`;
  office.setProjectName(p.name);
}

// ---- Peers --------------------------------------------------------------------------------------
function syncPeers() {
  for (const [id, peer] of store.peers) {
    if (id === store.you) continue;
    let r = remotes.get(id);
    if (!r) {
      const person = new Person(peer.name, peer.color, peer.look);
      person.root.position.set(peer.x, peer.y, peer.z);
      scene.add(person.root);
      noOutline(person.root);
      r = { person, target: new THREE.Vector3(peer.x, peer.y, peer.z), rotY: peer.rotY, moving: false, label: '', look: { ...peer.look }, stepT: 0 };
      remotes.set(id, r);
    }
    const label = `${peer.name}|${peer.voice ? (peer.muted ? 'm' : 'v') : '-'}|${peer.color}`;
    if (label !== r.label) {
      r.label = label;
      r.person.setLabel(peer.name, peer.voice ? peer.muted : null);
      r.person.setColor(peer.color);
      noOutline(r.person.root);
    }
    if (!sameLook(peer.look, r.look)) {
      r.look = { ...peer.look };
      r.person.setLook(peer.look);
      noOutline(r.person.root);
    }
  }
  for (const [id, r] of remotes) {
    if (!store.peers.has(id)) {
      scene.remove(r.person.root);
      if (r.bubble) disposeSprite(r.bubble.sprite);
      r.person.dispose();
      remotes.delete(id);
    }
  }
  renderPeople(voice, editProfile);
  refreshShares();
}
store.on('peers', syncPeers);

function sayBubble(from: string, text: string) {
  const short = text.length > 60 ? `${text.slice(0, 59)}…` : text;
  if (from === store.you) return;
  const r = remotes.get(from);
  if (!r) return;
  if (r.bubble) {
    r.person.root.remove(r.bubble.sprite);
    disposeSprite(r.bubble.sprite);
  }
  const sprite = textSprite(`💬 ${short}`, { bg: '#ffffff', size: 34 });
  sprite.position.y = 2.45;
  r.person.root.add(sprite);
  r.bubble = { sprite, until: performance.now() + 6000 };
}

// ---- Workers ------------------------------------------------------------------------------------
function shouldBounce(w: WorkerInfo) {
  return w.status === 'needs_input' || (w.status === 'done' && !w.acked);
}

function syncWorkers() {
  const fresh = store.evidence().fresh;
  for (const [id, view] of workerViews) if (!office.desks.has(view.deskId) || !store.workers.has(id)) {
    const oldDesk = office.desks.get(view.deskId);
    if (oldDesk) { oldDesk.setScreen(); oldDesk.vacancy.visible = true; }
    view.model.root.removeFromParent(); view.laptop.root.removeFromParent();
    life.remove(id); view.model.dispose(); view.laptop.dispose(); sound.removeTypist(id); workerViews.delete(id);
  }
  for (const w of store.workers.values()) {
    let v = workerViews.get(w.id);
    const desk = office.desks.get(w.deskId);
    if (!desk) continue;
    if (!v) {
      const model = new Worker(w.name, w.color);
      model.root.position.copy(desk.seatAnchor.position);
      model.root.position.y = 0;
      model.root.position.z += 0.08;
      model.root.rotation.y = Math.PI;
      model.root.scale.setScalar(1);
      desk.group.add(model.root);
      const laptop = new Laptop();
      laptop.root.position.copy(desk.laptopAnchor.position);
      laptop.root.position.z -= 0.08;
      laptop.root.scale.setScalar(1.3);
      // The terminal texture drives both Blender monitor panels. The keyboard is part of the workstation asset.
      desk.setScreen(laptop.displayTexture);
      laptop.root.visible = false;
      desk.group.add(laptop.root);
      noOutline(desk.group);
      desk.vacancy.visible = false;
      desk.chair.rotation.y = 0;
      v = { model, laptop, deskId: w.deskId, status: '', acked: true };
      workerViews.set(w.id, v);
    }
    if (v.status !== w.status || v.acked !== w.acked) {
      const becameHot = shouldBounce(w) && !(v.status === w.status && v.acked === w.acked) && v.status !== '' && (w.status !== v.status);
      if (becameHot && (w.status === 'needs_input' || w.status === 'done')) {
        sound.ding(w.status);
        if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          new Notification(`${w.name} ${w.status === 'done' ? 'is done' : 'needs input'}`, { body: w.activity ?? w.prompt ?? '', icon: '/favicon.svg' });
        }
      }
      v.status = w.status;
      v.acked = w.acked;
      v.model.setStatus(w.status, shouldBounce(w));
      noOutline(v.model.root);
    }
    v.model.setTask(w.task);
    v.model.setLive(fresh);
    // Typing (and its sound) only once the body is seated at the desk; see world/worker-life.ts.
    life.sync(w.id, v.model, desk, { status: w.status, processState: w.processState, fresh, typing: typingPose(w, fresh), waitingOn: (w as WorkerInfo & { waitingOn?: WaitingOn }).waitingOn });
    const again = w.kind === 'shell' ? 'restart' : 'resume';
    v.laptop.setPlaceholder(w.status === 'offline' ? `💤 ${w.name} is asleep — press R to ${again}` : w.status === 'exited' ? `${w.name} exited` : 'booting…');
  }
  for (const [id, v] of workerViews) {
    if (store.workers.has(id)) continue;
    const desk = office.desks.get(v.deskId);
    life.remove(id);
    v.model.root.removeFromParent();
    desk?.group.remove(v.laptop.root);
    v.model.dispose();
    v.laptop.dispose();
    if (desk) desk.vacancy.visible = true;
    sound.removeTypist(id);
    workerViews.delete(id);
  }
  renderWorkers((id) => openWorkerTerminal(id));
}
store.on('workers', syncWorkers);
store.on('freshness', syncWorkers);
// Staleness arrives without a message, so poll for it; the check emits only on a change.
setInterval(() => store.checkFreshness(), 1000);
store.on('workers', renderUsage);
store.on('usage', renderUsage);
const tower = new Tower(net, player, office, () => syncWorkers());

// ---- Actions ------------------------------------------------------------------------------------
function freeDesk(): string | null {
  // Prefer the empty desk nearest to you.
  let best: string | null = null;
  let bestD = Infinity;
  for (const { def: d } of office.desks.values()) {
    if (store.workerAtDesk(d.id)) continue;
    const dist = Math.hypot(d.x - player.pos.x, d.z - player.pos.z);
    if (dist < bestD) {
      bestD = dist;
      best = d.id;
    }
  }
  return best;
}

function hire(deskId: string, prompt?: string, worktree = false) {
  net.send({ t: 'worker.spawn', deskId, prompt, worktree });
}

function openShell(deskId: string) {
  net.send({ t: 'worker.spawn', deskId, kind: 'shell' });
}

function promptAtDesk(deskId: string) {
  const w = store.workerAtDesk(deskId);
  const desk = DESK_BY_ID.get(deskId)!;
  if (!w) {
    openPrompt({
      title: `✨ New task at ${desk.label}`,
      subtitle: 'A fresh Claude Code worker will sit down and start on this right away.',
      submitLabel: 'Hire & start',
      worktreeOption: !!store.project?.branch,
      onSubmit: (text, o) => hire(deskId, text, o.worktree),
    });
  } else if (w.status === 'exited' || w.status === 'offline') {
    toast(`${w.name} is asleep — press R to resume first`, 'warn');
  } else if (w.kind === 'shell') {
    openPrompt({
      title: `🐚 Run in ${w.name}`,
      placeholder: 'npm run dev',
      submitLabel: 'Run ▶',
      onSubmit: (text) => net.send({ t: 'worker.prompt', workerId: w.id, prompt: text }),
    });
  } else {
    openPrompt({
      title: `💬 Prompt ${w.name}`,
      subtitle: w.status === 'working' ? `${w.name} is busy — your message will be queued in their input box.` : undefined,
      onSubmit: (text) => net.send({ t: 'worker.prompt', workerId: w.id, prompt: text }),
    });
  }
}

function killWorker(id: string) {
  const w = store.workers.get(id);
  if (!w) return;
  const where = DESK_BY_ID.get(w.deskId)?.label ?? 'the desk';
  if (w.worktree) {
    // A worker with its own worktree: choose what becomes of the worktree and its branch.
    sendHomeDialog({
      workerId: id,
      name: w.name,
      where,
      worktree: w.worktree,
      ask: () => net.send({ t: 'worker.worktree', workerId: id }),
      onConfirm: (cleanup) => net.send({ t: 'worker.kill', workerId: id, cleanup }),
    });
    return;
  }
  confirmDialog(`Send ${w.name} home?`, `This stops the Claude Code session at ${where} for everyone and frees the desk.`, 'Send home', () =>
    net.send({ t: 'worker.kill', workerId: id }),
  );
}

function resumeWorker(w: WorkerInfo) {
  if (!w.sessionId && w.kind !== 'shell') toast(`${w.name} has no saved Claude session — starting a fresh one`, 'warn');
  net.send({ t: 'worker.resume', workerId: w.id });
}

/** Whether a worker's branch can become a PR: it has its own worktree and isn't mid-turn. */
function prReady(w: WorkerInfo) {
  return !!w.worktree && w.status !== 'starting' && w.status !== 'working' && w.status !== 'needs_input';
}

/** O at a desk: see the worker's pull request, or push its branch and open one. */
function pullRequestFor(w: WorkerInfo) {
  if (w.pr) {
    const it = store.pulls.items.find((p) => p.number === w.pr!.number);
    if (it) openPull(it, net, boardActions());
    else window.open(w.pr.url, '_blank', 'noopener');
    return;
  }
  if (!w.worktree) return toast(`${w.name} works in the main checkout — only workers with their own worktree can open a PR`, 'warn');
  if (w.prOpening) return;
  if (!prReady(w)) return toast(`${w.name} is still ${STATUS_LABEL[w.status]} — wait until it's done`, 'warn');
  toast(`Pushing ${w.worktree.branch} and opening a pull request…`);
  net.send({ t: 'worker.pr', workerId: w.id });
}

/** Puts you in front of a desk, looking at it: the PR board's "Go to desk". */
function goToDesk(deskId: string) {
  const desk = DESK_BY_ID.get(deskId);
  if (!desk) return;
  closeAllModals();
  const spot = deskSeat(desk, 2.4);
  player.pos.set(spot.x, 0, spot.z);
  player.vy = 0;
  player.facing = Math.atan2(desk.x - spot.x, desk.z - spot.z);
  player.camYaw = player.facing - Math.PI;
  player.lookPitch = -0.2;
  const w = store.workerAtDesk(deskId);
  toast(w ? `You're at ${desk.label}, ${w.name}'s desk` : `You're at ${desk.label}`);
}

/** Opening a sleeping worker's terminal wakes it, so there's nothing to press first. */
function openWorkerTerminal(id: string) {
  const w = store.workers.get(id);
  if (!w) return;
  if (w.status === 'exited' || w.status === 'offline') resumeWorker(w);
  openTerminal(net, id, () => openWorkerChanges(id));
}

/** What the worker changed: changed files, diff, commit / discard / open a PR. */
function openWorkerChanges(id: string) {
  if (!store.workers.has(id)) return;
  openChanges(net, id, () => openWorkerTerminal(id));
}

function showQueue() {
  if (cloudNet) return openCloudPanel(cloudNet, 'jobs');
  openQueue(net, { openTerminal: openWorkerTerminal });
}

/** A prompt from the boards goes to a new worker at a free desk, or to one already at a desk. */
function sendToWorker(title: string, text: { context?: string; initial?: string }) {
  const desk = freeDesk();
  const awake = [...store.workers.values()].filter((w) => w.kind === 'agent' && w.status !== 'exited' && w.status !== 'offline');
  if (!desk && !awake.length) {
    toast('Every desk is taken — send a worker home first', 'warn');
    return;
  }
  openAsk({
    title,
    ...text,
    newDesk: desk ? DESK_BY_ID.get(desk)!.label : undefined,
    workers: awake.map((w) => ({ id: w.id, name: w.name, color: w.color, status: w.status })),
    worktreeOption: !!store.project?.branch,
    onSubmit: (prompt, to, worktree) => {
      if (to) net.send({ t: 'worker.prompt', workerId: to, prompt });
      else if (desk) hire(desk, prompt, worktree);
    },
  });
}

function boardActions() {
  return {
    queue: (prompt: string, title: string, issue: number) => net.send({ t: 'queue.add', prompt, title, issue }),
    assign: (prompt: string, title: string) => sendToWorker(`🤖 ${title}`, { initial: prompt }),
    ask: (context: string, title: string) => sendToWorker(`✍️ ${title}`, { context }),
    goToDesk,
  };
}

/** Full-screen viewer for one share: the one given (a thumbnail), else whatever the TV shows. */
function watchShare(share?: [string, MediaStream]) {
  const pick = share ?? tvShare(currentShares());
  if (!pick) {
    void toggleShare();
    return;
  }
  const video = h('video', { autoplay: true, playsinline: true, muted: true }) as HTMLVideoElement;
  const [who, stream] = pick;
  video.srcObject = stream;
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const el = h('div.modal.viewer', { role: 'dialog', 'aria-label': 'Screen share' }, h('header', {}, h('h2', {}, `🖥️ ${who}'s screen`), close), video);
  // Close once that share stops: its track ends, or its sharer stops or leaves.
  const gone = () => {
    if (!currentShares().some(([, s]) => s === stream)) modal.close();
  };
  const tracks = stream.getVideoTracks();
  tracks.forEach((t) => t.addEventListener('ended', gone));
  const unsub = store.on('peers', gone);
  const modal = openModal(el, {
    onClose: () => {
      video.srcObject = null;
      tracks.forEach((t) => t.removeEventListener('ended', gone));
      unsub();
    },
  });
  close.addEventListener('click', () => modal.close());
}

function interact(target: Interactable | null, key: DeskKey) {
  if (!target) return;
  if (target.kind === 'desk' && target.deskId) {
    const w = store.workerAtDesk(target.deskId);
    if (key === 'B' && !w) return openShell(target.deskId);
    if (key === 'P') return promptAtDesk(target.deskId);
    if (key === 'E') return w ? openWorkerTerminal(w.id) : hire(target.deskId);
    if (key === 'C' && w) return openWorkerChanges(w.id);
    if (key === 'R' && w && (w.status === 'exited' || w.status === 'offline')) return resumeWorker(w);
    if (key === 'X' && w) return killWorker(w.id);
    if (key === 'O' && w) return pullRequestFor(w);
    return;
  }
  if (key !== 'E') return;
  if (target.kind === 'issues' || target.kind === 'pulls') openBoard(target.kind, net, boardActions());
  else if (target.kind === 'services') openServices();
  else if (target.kind === 'queue') showQueue();
  else if (target.kind === 'tv') watchShare();
  else if (target.kind === 'decor' && target.decorId) hanger.view(target.decorId);
  else if (target.kind === 'elevator') tower.open();
  else if (target.kind === 'coffee') {
    toast('☕ Mmm, fresh coffee. +10 focus');
    sound.coffee();
  }
  else if (target.kind === 'gym') toast('🏋️ A quick set in the gym corner.');
  else if (target.kind === 'cafeteria') toast('🥐 Breakfast from the cafeteria counter.');
}

// ---- Interaction targeting & hint -----------------------------------------------------------------
let target: Interactable | null = null;
let hintKey = '';

function pickTarget(): Interactable | null {
  let best: Interactable | null = null;
  let bestD = Infinity;
  for (const list of [office.interactables, ...(office.floor === 0 ? [gallery.interactables] : [])]) {
    for (const it of list) {
      const d = Math.hypot(it.x - player.pos.x, it.z - player.pos.z);
      if (d < it.radius && d < bestD) {
        best = it;
        bestD = d;
      }
    }
  }
  return best;
}

function key(k: string, label: string) {
  const action = (Object.keys(DEFAULT_KEYS) as Action[]).find(a => DEFAULT_KEYS[a] === `Key${k}`);
  return h('span', {}, h('span.key', {}, action ? keyLabel(settings.keys[action]) : k), label);
}

function renderHint() {
  const el = $('hint');
  if (hanger.active && !modalOpen()) return renderHangHint(el);
  if (!target || modalOpen()) {
    if (hintKey) {
      el.classList.add('hidden');
      hintKey = '';
    }
    return;
  }
  let parts: (HTMLElement | string)[] = [];
  let k = target.kind + (target.deskId ?? '');
  if (target.kind === 'desk' && target.deskId) {
    const w = store.workerAtDesk(target.deskId);
    const desk = DESK_BY_ID.get(target.deskId)!;
    if (!w) {
      const paused = hiringPaused();
      k += String(paused);
      parts = [
        h('span.title', {}, `${desk.label} · empty`),
        ...(paused ? [h('span.cost', {}, '💸 Budget spent — hiring resumes tomorrow')] : [key('E', 'Hire a worker'), key('P', 'Hire with a task')]),
        key('B', 'Shell'),
      ];
    } else {
      k += w.status + w.id + (w.pr?.number ?? '') + (w.prOpening ? '!' : '');
      const asleep = w.status === 'exited' || w.status === 'offline';
      const doing = w.activity ? (w.activity.length > 48 ? `${w.activity.slice(0, 47)}…` : w.activity) : '';
      const spent = w.usage?.calls ? usageLabel(w.usage) : '';
      k += doing + spent;
      parts = [
        h('span.title', {}, `${w.name} · ${STATUS_LABEL[w.status]}`),
        doing ? h('span', { style: 'opacity:.75;font-weight:600' }, doing) : '',
        spent ? h('span.cost', { title: usageTitle(w.usage!) }, spent) : '',
        key('E', 'Open terminal'),
        key('C', 'Changes'),
        asleep ? key('R', w.kind === 'shell' ? 'Restart' : 'Resume') : key('P', w.kind === 'shell' ? 'Run command' : 'Prompt'),
        w.pr ? key('O', `PR #${w.pr.number}`) : w.prOpening ? h('span', { style: 'opacity:.75;font-weight:600' }, '⏳ Opening PR…') : prReady(w) ? key('O', 'Open PR') : '',
        key('X', 'Send home'),
      ];
    }
  } else if (target.kind === 'issues') parts = [h('span.title', {}, '📌 Issues board'), key('E', 'Open')];
  else if (target.kind === 'pulls') parts = [h('span.title', {}, '🔀 Pull request board'), key('E', 'Open')];
  else if (target.kind === 'services') parts = [h('span.title', {}, '🌐 Services board'), key('E', 'Open')];
  else if (target.kind === 'queue') {
    const n = store.queue.tasks.filter((t) => t.status !== 'done').length;
    k += n;
    parts = [h('span.title', {}, `📋 Task queue${n ? ` · ${n}` : ''}`), key('E', 'Open')];
  }
  else if (target.kind === 'tv') {
    const any = currentShares().length > 0;
    k += any;
    parts = [h('span.title', {}, 'AGENT EMPIRE'), key('E', any ? 'Watch full screen' : 'Share your screen')];
  } else if (target.kind === 'elevator') parts = [h('span.title', {}, `Elevator · Floor ${office.floor + 1}`), key('E', 'Floor directory')];
  else if (target.kind === 'coffee') parts = [h('span.title', {}, '☕ Coffee machine'), key('E', 'Grab a cup')];
  else if (target.kind === 'gym') parts = [h('span.title', {}, '🏋️ Gym'), key('E', 'Work out')];
  else if (target.kind === 'cafeteria') parts = [h('span.title', {}, '🥐 Cafeteria'), key('E', 'Grab breakfast')];
  else if (target.kind === 'decor') {
    const id = target.decorId;
    const d = store.decor.find((x) => x.id === id);
    k += `${d?.title}|${d?.by}`;
    parts = [h('span.title', {}, `🖼️ ${d?.title || 'A picture'}`), d ? h('span', { style: 'opacity:.75;font-weight:600' }, `hung by ${d.by}`) : '', key('E', 'Look closer')];
  }
  if (k === hintKey) return;
  hintKey = k;
  el.replaceChildren(...parts);
  el.classList.remove('hidden');
}

function renderHangHint(el: HTMLElement) {
  const spot = hanger.spot;
  const k = `hang|${hanger.moving}|${spot ? spot.ok : '-'}`;
  if (k === hintKey) return;
  hintKey = k;
  const title = !spot ? '🖼️ Aim at a wall' : !spot.ok ? "🚫 Something's in the way" : hanger.moving ? '🖼️ Moving a picture' : '🖼️ Hanging a picture';
  el.replaceChildren(h('span.title', {}, title), key('Click', 'Hang'), key('Scroll', 'Size'), key('Esc', 'Cancel'));
  el.classList.remove('hidden');
}

let crossKey = '';
const finePointer = window.matchMedia('(pointer: fine)').matches;
function renderCrosshair() {
  const show = player.view === 'first' && !modalOpen();
  const free = show && finePointer && player.canLock && !player.locked;
  const k = `${show}|${!!target}|${free}`;
  if (k === crossKey) return;
  crossKey = k;
  const el = $('crosshair');
  el.classList.toggle('hidden', !show);
  el.classList.toggle('on', !!target);
  el.classList.toggle('free', free);
}

// ---- Reaching out ---------------------------------------------------------------------------------
let lastActSent = 0;
/** Plays the interaction gesture on your character, and shows it to everyone else. */
function reach() {
  me.reach();
  const now = performance.now();
  if (now - lastActSent > 120) {
    lastActSent = now;
    net.send({ t: 'act' });
  }
}

type DeskKey = 'E' | 'P' | 'R' | 'X' | 'B' | 'C' | 'O';

function use(it: Interactable | null, key: DeskKey) {
  if (!it) return;
  reach();
  interact(it, key);
}

// ---- Input ----------------------------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (modalOpen() || player.scripted || isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  if (hanger.active && hangingKey(officeCode(e.code, settings.keys))) {
    e.preventDefault();
    return;
  }
  // Holding a key must not re-send spawn/resume/PR for every auto-repeat.
  if (e.repeat) return;
  // Enter/Space on a focused button or link belongs to that control, not the game.
  if ((e.code === 'Enter' || e.code === 'Space') && (e.target as HTMLElement).closest?.('button, a, [role=button]')) return;
  switch (officeCode(e.code, settings.keys)) {
    case 'KeyE':
      if (traversal.interactCar() || empireUI.interact()) break;
      use(target, 'E');
      break;
    case 'KeyP':
      e.preventDefault();
      use(target, 'P');
      break;
    case 'KeyR':
      use(target, 'R');
      break;
    case 'KeyX':
      use(target, 'X');
      break;
    case 'KeyB':
      use(target, 'B');
      break;
    case 'KeyC':
      use(target, 'C');
      break;
    case 'KeyO':
      use(target, 'O');
      break;
    case 'KeyT':
    case 'Enter':
      e.preventDefault();
      ($('chat-input') as HTMLInputElement).focus();
      break;
    case 'KeyV':
      void toggleVoice();
      break;
    case 'KeyM':
      voice.toggleMute();
      break;
    case 'KeyG':
      empireUI.openMap();break;
    case 'KeyN':
      changeView();break;
    case 'KeyH':
      openHelp(settings.keys);
      break;
    case 'KeyF':
      if (office.floor > 0) { toast('Wall pictures are managed on the ground floor.'); break; }
      hanger.start();
      break;
    default:
      return;
  }
  player.clearKeys();
});

/** Keys while hanging a picture. Walking, chat and voice work as usual. */
function hangingKey(code: string): boolean {
  switch (code) {
    case 'Escape':
    case 'KeyF':
      hanger.cancel();
      return true;
    case 'KeyE':
    case 'Enter':
      reach();
      hanger.place();
      return true;
    case 'BracketLeft':
    case 'Minus':
      hanger.resize(-1);
      return true;
    case 'BracketRight':
    case 'Equal':
      hanger.resize(1);
      return true;
  }
  return false;
}

/** Whether the mouse was captured when the modals opened, so closing them gives it back. */
let relookAfterModal = false;
onModalChange((open) => {
  player.enabled = !open;
  player.clearKeys();
  if (open) {
    if (player.locked) relookAfterModal = true;
    player.unlock();
    $('hint').classList.add('hidden');
  } else {
    // A tick later, so closing one window to open the next (Settings → character) doesn't grab the mouse in between.
    setTimeout(backToGame, 0);
  }
  hintKey = '';
});

/** Once the last window is closed, the game has the keyboard again and, in first person, the mouse. */
function backToGame() {
  if (modalOpen()) return;
  if (!isTyping()) canvas.focus({ preventScroll: true });
  // The browser lets a page re-capture the mouse it let go of itself, even from Esc. Otherwise it
  // needs a recent click or key, like the one that closed the window; without one, "Click to look around".
  if (player.canLock && (relookAfterModal || navigator.userActivation?.isActive)) player.lock();
  relookAfterModal = false;
}

// ---- Clicking the world: use what's under the crosshair (first person) or the mouse (third) ----------
const raycaster = new THREE.Raycaster();
const CROSSHAIR = new THREE.Vector2(0, 0);
/** How close (meters from your eyes) you must be to use each kind of thing. */
const REACH: Record<InteractKind, number> = { elevator: 4, desk: 4.5, coffee: 3, gym: 5, cafeteria: 4, issues: 9, pulls: 9, services: 9, queue: 9, tv: 10, decor: 9 };
const eye = new THREE.Vector3();

/** What the ray through `ndc` lands on first, and whether it is within reach (plus `slack` meters). */
function aimedAt(ndc: THREE.Vector2, slack = 0): { it: Interactable; near: boolean } | null {
  raycaster.setFromCamera(ndc, camera);
  eye.set(player.pos.x, player.pos.y + EYE_HEIGHT, player.pos.z);
  for (const hit of raycaster.intersectObject(office.group, true)) {
    let it: Interactable | undefined;
    let shown = true;
    for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
      if (!o.visible) shown = false;
      it ??= o.userData.interact as Interactable | undefined;
    }
    if (!shown) continue;
    if (!it) return null; // a wall, the floor, a plant… is in the way
    return { it, near: hit.point.distanceTo(eye) <= REACH[it.kind] + slack };
  }
  return null;
}

player.onClick = (ndc) => {
  if (modalOpen()) return;
  if (hanger.active) {
    reach();
    hanger.place(ndc);
    return;
  }
  if (player.view === 'first') {
    // Reach out even at nothing, like poking the air.
    reach();
    if (target) interact(target, 'E');
    return;
  }
  const aim = aimedAt(ndc, 2.5);
  if (!aim) return;
  if (!aim.near) {
    toast('Walk closer to that first');
    return;
  }
  use(aim.it, 'E');
};

// Chat
const chatInput = $('chat-input') as HTMLInputElement;
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    const text = chatInput.value.trim();
    if (text) net.send({ t: 'chat', text });
    chatInput.value = '';
    chatInput.blur();
    e.preventDefault();
  } else if (e.key === 'Escape') chatInput.blur();
  e.stopPropagation();
});
store.on('chat', renderChat);

// ---- Voice & screen share ---------------------------------------------------------------------------
async function toggleVoice() {
  if (voice.inVoice) voice.leaveVoice();
  else {
    const err = await voice.joinVoice();
    if (err) toast(err, 'warn');
  }
}

async function toggleShare() {
  if (voice.sharing) voice.stopShare();
  else {
    const err = await voice.startShare();
    if (err) toast(err, 'warn');
  }
}

function currentShares(): [string, MediaStream][] {
  const out: [string, MediaStream][] = [];
  const local = voice.localScreen;
  if (local) out.push(['You', local]);
  for (const [id, s] of voice.remoteScreens()) out.push([store.peers.get(id)?.name ?? 'Someone', s]);
  return out;
}

/** Remote shares win the TV; your own share is what others see anyway. */
function tvShare(shares: [string, MediaStream][]): [string, MediaStream] | undefined {
  return shares.find(([who]) => who !== 'You') ?? shares[0];
}

let tvStream: MediaStream | null = null;
function refreshShares() {
  const shares = currentShares();
  const pick = tvShare(shares);
  const stream = pick?.[1] ?? null;
  if (stream !== tvStream) {
    tvStream = stream;
    tvVideo.srcObject = stream;
    if (stream) void tvVideo.play().catch(() => {});
    tvMat.map = stream ? tvTexture : tvIdle;
    tvMat.needsUpdate = true;
  }
  const box = $('shares');
  box.replaceChildren(
    ...shares
      .filter(([who]) => who !== 'You')
      .map(([who, s]) => {
        const v = h('video', { autoplay: true, playsinline: true, muted: true }) as HTMLVideoElement;
        v.srcObject = s;
        return h('div.share-thumb', { onclick: () => watchShare([who, s]), title: 'Watch full screen' }, v, h('span.who', {}, `🖥️ ${who}`));
      }),
  );
  hintKey = '';
}

voice.onChange(() => {
  const vb = $('btn-voice');
  vb.classList.toggle('on', voice.inVoice);
  vb.querySelector('span')!.textContent = voice.inVoice ? 'Leave voice' : 'Join voice';
  vb.setAttribute('aria-label', voice.inVoice ? 'Leave voice' : 'Join voice');
  const mb = $('btn-mute');
  mb.classList.toggle('hidden', !voice.inVoice);
  mb.textContent = voice.muted ? '🔇' : '🎙️';
  mb.setAttribute('aria-label', voice.muted ? 'Unmute microphone' : 'Mute microphone');
  mb.setAttribute('aria-pressed', String(voice.muted));
  mb.classList.toggle('danger', voice.muted);
  const sb = $('btn-share');
  sb.classList.toggle('on', voice.sharing);
  sb.querySelector('span')!.textContent = voice.sharing ? 'Stop sharing' : 'Share screen';
  sb.setAttribute('aria-label', voice.sharing ? 'Stop sharing screen' : 'Share screen');
  refreshShares();
});

// Buttons must not keep focus, or Space (jump) would click them again.
$('hud').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (btn) setTimeout(() => btn.blur(), 0);
});
if (!window.isSecureContext) {
  for (const id of ['btn-voice', 'btn-share']) {
    const b = $(id);
    b.style.opacity = '0.55';
    b.title = 'Voice and screen sharing need HTTPS or localhost — use a TLS proxy, --self-signed, or an SSH tunnel';
  }
}
$('btn-voice').addEventListener('click', () => void toggleVoice());
$('btn-mute').addEventListener('click', () => voice.toggleMute());
$('btn-share').addEventListener('click', () => void toggleShare());
$('btn-issues').addEventListener('click', () => openBoard('issues', net, boardActions()));
$('btn-pulls').addEventListener('click', () => openBoard('pulls', net, boardActions()));
mountServicesButton($('btn-services'));
mountQueueButton($('btn-queue'), showQueue);
$('btn-team').addEventListener('click', () => openTeam(net));
$('btn-upgrade').addEventListener('click', () => openUpgrade(net));
$('btn-help').addEventListener('click', () => openHelp(settings.keys));
$('btn-decor').addEventListener('click', () => office.floor > 0 ? toast('Wall pictures are managed on the ground floor.') : (hanger.active ? hanger.cancel() : hanger.start()));
$('btn-settings').addEventListener('click', () =>
  openSettings(
    settings,
    (s) => {
      const qualityChanged = settings.quality !== s.quality;
      Object.assign(settings, s);
      if (qualityChanged) { applyGraphics(settings.quality, renderer, composer, ao, sun, scene); city.setQuality(settings.quality); resize(); }
      saveSettings(settings);
      player.setView(settings.view);
      player.bindings = settings.keys;
      paintViewButton();
      player.clearKeys();
      hintKey = '';
      sound.setVolume(settings.volume, settings.muted);
    },
    editProfile,
    () => sound.ding('done'),
    combineSections(appPanel(net), updateSettingsSection(updateService)),
  ),
);

function combineSections(...sections: { el: HTMLElement; dispose(): void }[]) {
  const el = document.createElement('div');
  el.append(...sections.map((s) => s.el));
  return { el, dispose: () => sections.forEach((s) => s.dispose()) };
}

function editProfile() {
  openCharacter(false, (p) => {
    showMyProfile(p);
    net.send({ t: 'profile', name: p.name, color: p.color, look: p.look });
  });
}

// ---- Main loop ---------------------------------------------------------------------------------------
const headPos = new THREE.Vector3();
function resize() {
  const w = window.innerWidth;
  const hgt = window.innerHeight;
  // Here rather than once at startup: moving to another monitor or zooming changes the device
  // ratio. The quality profile still caps it.
  const ratio = Math.min(window.devicePixelRatio || 1, GRAPHICS[settings.quality].pixelRatio);
  if (renderer.getPixelRatio() !== ratio) { renderer.setPixelRatio(ratio); composer.setPixelRatio(ratio); }
  renderer.setSize(w, hgt, false);
  composer.setSize(w, hgt);
  camera.aspect = w / hgt;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const timer = new THREE.Timer();
let lastSent = { x: 0, y: 0, z: 0, rotY: 0, moving: false, at: 0 };
let speakTick = 0;
/** Which half-stride your walk is on, so each one plays a footstep. */
let stride = 0;
/** How fast you were falling, so landing a jump thumps but stepping down a stair doesn't. */
let fallV = 0;
const lookDir = new THREE.Vector3();

function frame(ts?: number) {
  timer.update(ts);
  const dt = Math.min(timer.getDelta(), 0.1);
  const t = timer.getElapsed();

  renderer.info.reset();
  player.update(dt);
  if (!tower.active) traversal.update(dt);
  tower.update(dt);
  city.update(t, dt,player.pos,player.driving);
  empireUI.update(dt);
  canvas.dataset.position = `${player.pos.x.toFixed(1)}, ${player.pos.y.toFixed(1)}, ${player.pos.z.toFixed(1)}`;
  canvas.dataset.view = player.view;
  canvas.dataset.traversal = tower.active ? 'elevator' : traversal.state;
  canvas.dataset.floor = String(office.floor + 1);
  canvas.dataset.motion = me.motion ?? 'loading';
  // The splash hands over only when the player is textured and the sky lighting is in (ui/loading.ts).
  const pending = [!me.materialsReady && 'character', !scene.environment && 'sky lighting', !city.car.userData.ready && 'car'].filter(Boolean).join(', ');
  canvas.dataset.assets = pending ? 'loading' : 'ready';
  canvas.dataset.pending = pending;
  canvas.dataset.fps = String(Math.round(1 / Math.max(dt,.001)));


  if (player.driving) { city.car.position.copy(player.pos); city.car.rotation.y=player.facing; }
  const outside = player.pos.z >= 30;
  city.animateCar(dt, player.vehicle, player.driving);
  sound.environment(outside);
  sound.vehicle(player.vehicle, player.driving, city.car.position, player.view === 'first');
  canvas.dataset.audio = sound.recordings;
  canvas.dataset.vehicle = `${(Math.abs(player.drivingSpeed)*3.6).toFixed(0)} km/h · ${player.vehicle.rpm.toFixed(0)} rpm`;
  office.group.visible = !outside;
  city.chief.visible = office.floor === 0;
  gallery.group.visible = office.floor === 0;
  city.group.visible = outside;
  sun.position.set(player.pos.x-24, player.pos.y+40, player.pos.z+24);
  sun.target.position.set(player.pos.x,player.pos.y,player.pos.z);
  sun.target.updateMatrixWorld();

  me.root.position.copy(player.pos);
  me.root.position.y += player.stepOffset;
  me.root.rotation.y = player.facing;
  me.update(dt,t,player.moving&&player.grounded,!player.grounded,player.speed);
  traversal.placeDriver();
  me.setVoiceLevel(voice.inVoice ? voice.localLevel : 0);
  const firstPerson = player.view === 'first';
  // In first person you are the camera; in third, hide yourself when it's zoomed in right behind your head.
  me.root.visible = !firstPerson && camera.position.distanceTo(headPos.set(player.pos.x, player.pos.y + 1.3, player.pos.z)) > 1.5;

  // Your ears are in your head, facing wherever the camera looks.
  camera.getWorldDirection(lookDir);
  sound.update({ x: player.pos.x, y: player.pos.y + EYE_HEIGHT - (outside ? 0 : office.group.position.y), z: player.pos.z, fx: lookDir.x, fz: lookDir.z });
  const s = Math.floor(player.walkPhase / Math.PI);
  if (s !== stride) {
    stride = s;
    if (player.moving && player.grounded && !player.driving) sound.step('walk', player.speed > 2.5);
  }
  if (!player.grounded) fallV = Math.min(fallV, player.vy);
  else {
    if (fallV < -4) sound.step('land');
    fallV = 0;
  }

  const now = performance.now();
  const moved = Math.abs(player.pos.x - lastSent.x) + Math.abs(player.pos.y - lastSent.y) + Math.abs(player.pos.z - lastSent.z) > 0.01 || Math.abs(player.facing - lastSent.rotY) > 0.02;
  if ((moved || player.moving !== lastSent.moving) && now - lastSent.at > 66) {
    lastSent = { x: player.pos.x, y: player.pos.y, z: player.pos.z, rotY: player.facing, moving: player.moving, at: now };
    net.send({ t: 'move', x: player.pos.x, y: player.pos.y, z: player.pos.z, rotY: player.facing, moving: player.moving });
  }

  for (const [id, r] of remotes) {
    const p = store.peers.get(id);
    if (!p) continue;
    r.person.root.visible = (p.z >= 30) === outside && (outside || Math.floor((p.y + .01) / FLOOR_RISE) === office.floor);
    r.target.set(p.x, p.y, p.z);
    const pos = r.person.root.position;
    pos.lerp(r.target, Math.min(1, dt * 12));
    let diff = p.rotY - r.person.root.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    r.person.root.rotation.y += diff * Math.min(1, dt * 12);
    // On their feet if they're standing on something: the floor, a desk, a stair, the loft.
    const airborne = p.y > groundAt(office.colliders, p.x, p.z, p.y) + 0.05;
    const walking = r.person.root.visible && p.moving && !airborne;
    r.person.update(dt, t, walking, airborne && Math.abs(pos.y - r.target.y) > 0.01, 1.65, 0.15);
    // Their walk cycle takes a step every π/11 seconds.
    r.stepT = walking ? r.stepT + dt : 0.2;
    if (r.stepT >= Math.PI / 11) {
      r.stepT -= Math.PI / 11;
      sound.stepAt(pos.x, pos.z);
    }
    r.person.setVoiceLevel(p.voice && !p.muted ? voice.levelOf(id) : 0);
    if (r.bubble && now > r.bubble.until) {
      r.person.root.remove(r.bubble.sprite);
      disposeSprite(r.bubble.sprite);
      r.bubble = undefined;
    }
    const d = Math.hypot(pos.x - player.pos.x, pos.z - player.pos.z);
    voice.setVolume(id, !r.person.root.visible ? 0 : d < 4 ? 1 : Math.max(0.2, 1 - (d - 4) / 16));
  }

  const camPos = camera.position;
  life.update(dt);
  for (const [id, v] of workerViews) {
    v.model.update(dt, t);
    const desk = DESK_BY_ID.get(v.deskId)!;
    v.laptop.update(dt, store.screens.get(id), Math.hypot(desk.x - camPos.x, desk.z - camPos.z));
  }
  office.update(t);
  hanger.update();

  if (modalOpen() || hanger.active) target = null;
  else if (firstPerson) {
    const aim = aimedAt(CROSSHAIR);
    target = aim?.near ? aim.it : null;
  } else target = pickTarget();
  renderHint();
  renderCrosshair();

  if (now - speakTick > 200) {
    speakTick = now;
    updateSpeaking(voice);
  }

  composer.render();
  canvas.dataset.drawCalls=String(renderer.info.render.calls);
  requestAnimationFrame(frame);
}

// ---- Boot ------------------------------------------------------------------------------------------
function boot() {
  net.connect();
  requestAnimationFrame(frame);
  if ('Notification' in window && Notification.permission === 'default') {
    window.addEventListener('pointerdown', () => void Notification.requestPermission().catch(() => {}), { once: true });
  }
}

const saved = loadProfile();
if (saved?.look) {
  store.profile = { ...saved, look: saved.look };
  showMyProfile(store.profile);
  boot();
} else {
  // Pick a character first (people from before there was a choice keep their name and color).
  if (saved) Object.assign(store.profile, { name: saved.name, color: saved.color });
  // Render the office behind the character select screen.
  requestAnimationFrame(frame);
  openCharacter(true, (p) => {
    showMyProfile(p);
    net.connect();
  });
}

// Debug handle for quick checks from the console / headless screenshots.
(window as any).__office = { store, player, camera, workerViews, scene, net, renderer, me, remotes, settings, gallery, hanger, city, empireUI, life };
(window as any).__voice = voice;
(window as any).__sound = sound;
