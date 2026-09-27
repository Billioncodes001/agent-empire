/** Local-only synthetic wire server for manual browser QA. Never starts a worker or reads a save. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { initialEmpire, MANAGER_NAMES, type SupervisionState } from '../src/shared/empire.js';
import type { ServerMsg, WorkerInfo, QueueTask } from '../src/shared/protocol.js';

const port = Number(process.env.FIXTURE_PORT || 4613);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 4610) throw new Error('Use an isolated fixture port (not 4610).');
const root = resolve(import.meta.dirname, '../dist/public');
const scenarios = ['working', 'idle', 'needs_input', 'turn_ended', 'interrupted', 'unknown', 'missing', 'stale', 'disconnected'] as const;
let scenario: typeof scenarios[number] = 'needs_input';
const sockets = new WebSocketServer({ noServer: true });
const send = (ws: WebSocket, msg: ServerMsg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
function snapshot() {
  const now = Date.now();
  const phase: SupervisionState['chief']['phase'] = ['missing', 'stale', 'disconnected'].includes(scenario) ? 'working' : scenario as SupervisionState['chief']['phase'];
  const status: WorkerInfo['status'] = phase === 'turn_ended' ? 'done' : phase === 'interrupted' || phase === 'unknown' ? 'offline' : phase as WorkerInfo['status'];
  const worker: WorkerInfo = { id: 'fixture-chief', kind: 'agent', deskId: 'desk-1', name: 'Alex · fixture', color: '#54bab6', status,
    processState: phase === 'interrupted' ? 'stopped' : phase === 'unknown' ? 'unknown' : 'running',
    acked: false, createdBy: 'Fixture', createdAt: now, cols: 90, rows: 25, viewers: [],
    task: { name: 'Review district operations', summary: 'Synthetic browser fixture — no AI provider is running' } };
  const task: QueueTask = { id: 'fixture-task', jobKey: 'fixture-chief-job', title: 'Prepare district brief', prompt: 'Synthetic fixture',
    addedBy: 'Fixture', addedAt: now, status: phase === 'turn_ended' || phase === 'interrupted' ? 'done' : 'running', attempt: 1,
    workerId: worker.id, ...(phase === 'interrupted' ? { interruption: { reason: 'server_restart' as const, at: now }, outcome: 'exited' as const } : {}),
    ...(phase === 'turn_ended' ? { outcome: 'done' as const } : {}) };
  const state = initialEmpire(now);
  state.setup = { completed: true, selected: ['hospital', 'cafe'], completedAt: now };
  state.office = { floors: 2, workstations: 20 };
  for (const sector of state.sectors) if (['hq', 'hospital', 'cafe'].includes(sector.id)) {
    sector.built = true; sector.staff = 1;
    sector.manager = { id: `fixture-${sector.id}`, name: MANAGER_NAMES[sector.id], status: sector.id === 'hq' ? phase === 'working' ? 'working' : phase === 'needs_input' ? 'needs_input' : phase === 'turn_ended' || phase === 'idle' ? 'ready' : 'offline' : 'pending',
      attempt: 1, jobKey: sector.id === 'hq' ? task.jobKey! : `fixture-${sector.id}`, ...(sector.id === 'hq' ? { taskId: task.id, workerId: worker.id } : {}) };
  }
  state.reports = [{ at: now, sector: 'Fixture', text: 'Synthetic district for interface testing. No provider jobs or real city data.' }];
  state.supervision = { schemaVersion: 1, serverRunId: 'fixture-run', observedAt: now, delegationRequested: true,
    monitor: { mode: 'rule_based', lastCheckAt: now }, chief: { phase, managerId: 'fixture-hq', taskId: task.id, workerId: worker.id,
      reason: phase === 'needs_input' ? 'Waiting for a permission decision in the terminal.' : phase === 'interrupted' ? 'The server restarted; this attempt was interrupted.' : phase === 'unknown' ? 'Prior process state cannot be established. Diagnose it before retrying.' : 'Synthetic observed state.' },
    workforce: { active: phase === 'working' ? 1 : 0, attention: phase === 'needs_input' ? 1 : 0, queued: 0 } };
  if (scenario === 'missing') delete state.supervision;
  return { state, worker, task };
}
function publish(ws: WebSocket) {
  const {state, worker, task} = snapshot();
  send(ws, { t: 'worker.update', worker });
  send(ws, { t: 'queue', state: { tasks: [task], maxWorkers: 1 } });
  send(ws, { t: 'empire', state });
}
const controls = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Agent Empire QA controls</title>
<style>body{font:17px system-ui;background:#101923;color:#e7eef6;max-width:760px;margin:4rem auto;padding:1rem}button,a{font:inherit;margin:.4rem;padding:.6rem;color:inherit}button{background:#22374a;border:1px solid #8194a9;border-radius:8px}a{display:block}</style>
<h1>Isolated UI fixture</h1><p>Only synthetic protocol messages. No workers, providers, saved city, or live server access.</p>
<a href="/" target="_blank">Open simulation fixture</a><p>Choose a scenario, then inspect the simulation. Stale stops updates; disconnected closes and refuses sockets.</p>
${scenarios.map(s => `<button type="button" data-scenario="${s}">${s}</button>`).join('')}<p role="status" id="status"></p>
<script>for(const b of document.querySelectorAll('button'))b.onclick=async()=>{const r=await fetch('/__fixture/scenario/'+b.dataset.scenario,{method:'POST'});document.querySelector('#status').textContent=await r.text()};fetch('/__fixture/state').then(r=>r.text()).then(t=>document.querySelector('#status').textContent=t)</script></html>`;
const mime: Record<string,string> = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.svg':'image/svg+xml', '.glb':'model/gltf-binary', '.hdr':'application/octet-stream', '.mp3':'audio/mpeg', '.wav':'audio/wav', '.ogg':'audio/ogg', '.woff2':'font/woff2' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  res.setHeader('Cache-Control', 'no-store');
  if (url.pathname === '/__fixture') { res.setHeader('Content-Type', 'text/html'); return res.end(controls); }
  if (url.pathname === '/__fixture/state') return res.end(`Scenario: ${scenario}`);
  if (url.pathname.startsWith('/__fixture/scenario/') && req.method === 'POST') {
    if (req.headers.origin && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(req.headers.origin)) { res.writeHead(403); return res.end(); }
    const next = url.pathname.split('/').at(-1);
    if (!scenarios.includes(next as any)) { res.writeHead(400); return res.end('Unknown fixture scenario'); }
    scenario = next as typeof scenario;
    for (const ws of sockets.clients) scenario === 'disconnected' ? ws.close() : publish(ws);
    return res.end(`Scenario: ${scenario}`);
  }
  if (url.pathname === '/api/whoami') { res.setHeader('Content-Type', 'application/json'); return res.end('{"ok":true}'); }
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  try {
    const file = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(root + sep)) { res.writeHead(403); return res.end(); }
    const data = await readFile(file); res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream'); res.end(data);
  } catch { res.writeHead(404); res.end('Fixture asset not found. Run npm run build:client first.'); }
});
server.on('upgrade', (req, socket, head) => {
  if (scenario === 'disconnected' || new URL(req.url || '/', `http://localhost:${port}`).pathname !== '/ws') { socket.destroy(); return; }
  sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws));
});
sockets.on('connection', ws => {
  const {worker, task} = snapshot();
  const empty = { items: [], fetchedAt: Date.now(), loading: false };
  const zero = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, calls: 0 };
  send(ws, { t: 'welcome', you: 'fixture-ceo', peers: [], workers: [worker], project: { name: 'UI fixture · synthetic data', dir: '[isolated fixture]', agentCmd: 'disabled' },
    issues: empty, pulls: empty, ice: [], chat: [], invites: false, version: 'fixture', upgrade: { available: false, phase: 'idle' },
    services: { items: [], port }, decor: [], usage: { total: zero, today: zero, day: '2026-09-27', pauseHiring: false }, queue: { tasks: [task], maxWorkers: 1 } });
  publish(ws);
  ws.on('message', raw => {
    let msg: any; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'worker.attach') send(ws, { t: 'term.snapshot', workerId: 'fixture-chief', cols: 90, rows: 25, data: 'SYNTHETIC TERMINAL — no commands execute.\r\nType to test keyboard routing: ' });
    else if (msg.t === 'term.input' && typeof msg.data === 'string') send(ws, { t: 'term.data', workerId: 'fixture-chief', data: msg.data.replace(/\r/g, '\r\n') });
    else if (msg.t === 'ping') send(ws, { t: 'pong', at: msg.at });
    else if (!['peer.move', 'peer.update', 'term.resize', 'worker.detach'].includes(msg.t)) send(ws, { t: 'toast', level: 'info', text: 'Fixture only: this action does not change real data.' });
  });
});
const timer = setInterval(() => { if (!['stale', 'disconnected'].includes(scenario)) for (const ws of sockets.clients) publish(ws); }, 3000);
server.listen(port, '127.0.0.1', () => console.log(`UI fixture: http://localhost:${port}/ — controls: http://localhost:${port}/__fixture`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { clearInterval(timer); for (const ws of sockets.clients) ws.terminate(); sockets.close(); server.close(); });
