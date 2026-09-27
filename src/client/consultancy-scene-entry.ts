export {};
// Kept separate from the operational UI: 3D failure never prevents a job or approval.
const host = document.getElementById('headquarters-scene');
const toggle = document.getElementById('scene-toggle') as HTMLButtonElement | null;
const status = document.getElementById('scene-status');
if (host && toggle && status) {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  let cleanup: (() => void) | undefined, loading = false, generation = 0, active = true;
  let observer: IntersectionObserver | undefined;
  const fallback = (message: string) => {
    status.textContent = message; host.dataset.scene = 'fallback';
    toggle.textContent = 'Load 3D view'; toggle.disabled = false; toggle.removeAttribute('aria-pressed');
  };
  async function load() {
    if (cleanup || loading || !active) return;
    loading = true; const token = generation; toggle!.disabled = true;
    status!.textContent = 'Preparing the architectural view…';
    try {
      const { mountHeadquartersScene } = await import('./consultancy-scene');
      if (token !== generation || !active) return;
      cleanup = mountHeadquartersScene(host!, toggle!, status!);
    } catch { if (token === generation) fallback('Architectural illustration · 3D unavailable on this device'); }
    finally { if (token === generation) loading = false; }
  }
  function start() {
    active = true;
    if (connection?.saveData) { fallback('Data saver · architectural illustration'); return; }
    toggle!.disabled = true;
    observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); requestAnimationFrame(() => requestAnimationFrame(() => void load())); } });
    observer.observe(host!);
  }
  toggle.addEventListener('click', () => { if (!cleanup) void load(); });
  window.addEventListener('pagehide', () => { active = false; generation++; loading = false; observer?.disconnect(); cleanup?.(); cleanup = undefined; });
  window.addEventListener('pageshow', event => { if (event.persisted) start(); });
  start();
}
