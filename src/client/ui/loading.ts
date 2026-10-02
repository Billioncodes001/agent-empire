/**
 * Drives the branded splash in index.html from real loading work only:
 * - file counts from three.js's DefaultLoadingManager (every GLTF/texture/HDR loader in the client uses it), and
 * - the scene readiness flag main.ts already publishes on the canvas (`data-assets="ready"`).
 * Imported first by main.ts so it sees every file the scene requests. There is no timer-driven progress.
 */
import * as THREE from 'three';

type Kind = 'models' | 'textures' | 'sky' | 'other';
const KIND_LABEL: Record<Kind, string> = { models: 'models', textures: 'textures', sky: 'sky lighting', other: 'audio & data' };
const kindOf = (url: string): Kind => {
  const path = url.split('?')[0].toLowerCase();
  // GLTFLoader decodes a model's embedded images through blob: URLs.
  if (path.startsWith('blob:')) return 'textures';
  if (/\.(glb|gltf|fbx|bin)$/.test(path)) return 'models';
  if (/\.(hdr|exr)$/.test(path)) return 'sky';
  if (/\.(jpe?g|png|webp|ktx2|avif)$/.test(path)) return 'textures';
  return 'other';
};
// Embedded images decode through blob: URLs; the corporate avatars' textures are files under /models/avatars/.
const shortName = (url: string) => (url.startsWith('blob:') || /\/models\/avatars\/.+\.webp/.test(url) ? 'character textures' : decodeURIComponent(url.split('?')[0].split('/').pop() || url));

const splash = document.getElementById('splash');
const bar = splash?.querySelector<HTMLElement>('.splash-bar i');
const meter = splash?.querySelector<HTMLElement>('[role=progressbar]');
const stage = splash?.querySelector<HTMLElement>('.splash-stage');
const detail = splash?.querySelector<HTMLElement>('.splash-detail');
const actions = splash?.querySelector<HTMLElement>('.splash-actions');
const root = document.documentElement;

const counts: Record<Kind, { total: number; done: number }> = {
  models: { total: 0, done: 0 },
  textures: { total: 0, done: 0 },
  sky: { total: 0, done: 0 },
  other: { total: 0, done: 0 },
};
const failed: string[] = [];
let shown = 0;
let settledAt = 0;
let finished = false;

if (splash) {
  root.dataset.boot = 'loading';
  const manager = THREE.DefaultLoadingManager;
  // LoadingManager defines these per instance; wrapping them observes each request without changing loading.
  const itemStart = manager.itemStart.bind(manager);
  const itemEnd = manager.itemEnd.bind(manager);
  const itemError = manager.itemError.bind(manager);
  manager.itemStart = (url: string) => {
    counts[kindOf(url)].total++;
    settledAt = 0;
    itemStart(url);
    render();
  };
  manager.itemEnd = (url: string) => {
    counts[kindOf(url)].done++;
    itemEnd(url);
    render();
  };
  manager.itemError = (url: string) => {
    failed.push(url);
    itemError(url);
    render();
  };
  if (stage) stage.textContent = 'Starting the renderer';
  const poll = window.setInterval(() => {
    if (finished) return window.clearInterval(poll);
    render();
  }, 150);
}

function sceneReady(): boolean {
  return (document.getElementById('scene') as HTMLCanvasElement | null)?.dataset.assets === 'ready';
}

function render() {
  if (!splash || finished) return;
  const all = Object.values(counts).reduce((a, c) => ({ total: a.total + c.total, done: a.done + c.done }), { total: 0, done: 0 });
  const ready = sceneReady();
  if (ready) return finish('ready');
  const settled = all.total > 0 && all.done >= all.total;
  if (settled && !settledAt) settledAt = performance.now();
  // 5% for the engine being up, 85% spread over requested files, the last 10% only when the scene reports ready.
  const pct = Math.round(5 + (all.total ? (85 * all.done) / all.total : 0));
  shown = Math.max(shown, Math.min(95, pct));
  if (bar) bar.style.transform = `scaleX(${shown / 100})`;
  meter?.setAttribute('aria-valuenow', String(shown));
  if (stage) {
    const pending = (Object.keys(counts) as Kind[]).filter((k) => counts[k].done < counts[k].total);
    stage.textContent = !all.total
      ? 'Starting the renderer'
      : pending.length
        ? `Loading ${pending.map((k) => (k === 'sky' ? KIND_LABEL[k] : `${KIND_LABEL[k]} ${counts[k].done}/${counts[k].total}`)).join(' · ')}`
        : 'Preparing your character and the district';
  }
  if (detail) detail.textContent = all.total ? `${all.done} of ${all.total} files` : '';
  // Escape hatches for a real failure (a file failed, or every file settled and the scene still lacks something
  // for 20 s); never a timed fake completion. Failed sky lighting and character textures are retried in the
  // background, so the splash can still finish on its own while the button is offered.
  const stalled = settled && settledAt && performance.now() - settledAt > 20000;
  if ((failed.length && settled) || stalled) {
    if (actions && !actions.childElementCount) {
      const why = document.createElement('p');
      why.className = 'splash-warn';
      const enter = document.createElement('button');
      enter.type = 'button';
      enter.className = 'splash-enter';
      enter.textContent = 'Enter anyway';
      enter.onclick = () => finish('forced');
      actions.append(why, enter);
    }
    const why = actions?.querySelector('.splash-warn');
    const names = [...new Set(failed.map(shortName))];
    const missing = (document.getElementById('scene') as HTMLCanvasElement | null)?.dataset.pending;
    if (why) why.textContent = names.length
      ? `Could not load ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}. Retrying where possible; if you enter now the city may look incomplete.`
      : `Still waiting for ${missing || 'the scene'}. You can wait or enter now.`;
  }
}

function finish(how: 'ready' | 'forced') {
  if (!splash || finished) return;
  finished = true;
  root.dataset.boot = how;
  if (bar) bar.style.transform = 'scaleX(1)';
  meter?.setAttribute('aria-valuenow', '100');
  if (stage) stage.textContent = how === 'ready' ? 'Ready' : 'Entering with some assets missing';
  splash.classList.add('done');
  splash.setAttribute('aria-busy', 'false');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.setTimeout(() => splash.remove(), reduce ? 0 : 520);
}
