/**
 * Developer review surface for the game's dialogs, deliberately excluded from the production build entries (like
 * visual-review). `npx vite --port 4811` then open /dialog-review.html?d=<name>. Every dialog is opened by its real
 * code with synthetic data; nothing talks to a server (fetch for /api/gh/* is answered locally).
 * Names: issues, pulls, pull, merge, issue, ask, hang, picture, workers, tower, viewer.
 */
import './style.css';
import { store } from './state';
import { h, openModal } from './ui/dom';
import { openBoard, type BoardActions } from './ui/boards';
import { openIssue, openPull } from './ui/pull';
import { openAsk } from './ui/ask';
import { openHangDialog, openPicture } from './ui/decor';
import { openWorkersDialog } from './ui/hud';
import { Tower } from './tower';
import type { GhIssue, GhPull, GhPullDetail, WorkerInfo } from '../shared/protocol';
import type { Net } from './net';
if (!import.meta.env.DEV) throw new Error('Dialog review is development-only');

const now = Date.now();
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const label = (name: string, color: string) => ({ name, color });
const issues: GhIssue[] = [
  { number: 41, title: 'Café menu board should show today’s specials', state: 'OPEN', url: 'https://github.com/example/city/issues/41', author: 'founder', labels: [label('enhancement', '#a2eeef'), label('good first issue', '#7057ff')], assignees: [], createdAt: iso(300), updatedAt: iso(30), body: 'The café board is static.', comments: 2 },
  { number: 38, title: 'Hospital lobby lights flicker on Medium graphics', state: 'OPEN', url: 'https://github.com/example/city/issues/38', author: 'pixel', labels: [label('bug', '#d73a4a')], assignees: ['pixel'], createdAt: iso(900), updatedAt: iso(120), body: 'Repro: Medium preset, walk into the lobby.', comments: 0 },
  { number: 35, title: 'Document the outreach suppression list', state: 'OPEN', url: 'https://github.com/example/city/issues/35', author: 'founder', labels: [label('docs', '#0075ca')], assignees: [], createdAt: iso(3000), updatedAt: iso(2000), body: '', comments: 1 },
];
const pulls: GhPull[] = [
  { number: 44, title: 'Add specials to the café menu board', state: 'OPEN', isDraft: false, url: 'https://github.com/example/city/pull/44', author: 'pixel', labels: [label('enhancement', '#a2eeef')], reviewDecision: 'APPROVED', headRefName: 'office/pixel-4d53', baseRefName: 'main', createdAt: iso(200), updatedAt: iso(10), additions: 128, deletions: 14, checks: 'pass', body: 'Closes #41.', closes: [41] },
  { number: 43, title: 'Fix lobby light flicker', state: 'OPEN', isDraft: true, url: 'https://github.com/example/city/pull/43', author: 'nova', labels: [label('bug', '#d73a4a')], reviewDecision: '', headRefName: 'office/nova-1a2b', baseRefName: 'main', createdAt: iso(500), updatedAt: iso(60), additions: 9, deletions: 3, checks: 'pending', body: '', closes: [38] },
];
const detail: GhPullDetail = {
  number: 44, body: 'Adds a specials list to the café menu board.\n\nCloses #41.', state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED',
  headRefName: 'office/pixel-4d53', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', commits: 3,
  comments: [{ id: 'c1', author: 'founder', body: 'Looks good — can the specials rotate daily?', createdAt: iso(90) }],
  reviews: [{ id: 'r1', author: 'reviewer', body: 'Approved.', createdAt: iso(40), state: 'APPROVED' }],
  reviewComments: [], checks: [{ name: 'test', state: 'pass' }, { name: 'build', state: 'pass' }, { name: 'lint', state: 'skip' }],
  repo: { nameWithOwner: 'example/city', methods: ['squash', 'merge', 'rebase'] },
};
const diff = 'diff --git a/src/menu.ts b/src/menu.ts\n--- a/src/menu.ts\n+++ b/src/menu.ts\n@@ -1,3 +1,4 @@\n export const menu = [\n+  \'Specials\',\n   \'Coffee\',\n ];\n';
const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
  if (url.includes('/api/gh/pull/diff')) return new Response(diff);
  if (url.includes('/api/gh/pull')) return json(detail);
  if (url.includes('/api/gh/issue')) return json({ number: 41, body: 'The café board is static. It should list today’s specials.', comments: [{ id: 'i1', author: 'pixel', body: 'On it.', createdAt: iso(20) }] });
  return realFetch(input, init);
};

const worker = (id: string, name: string, color: string, status: WorkerInfo['status'], task: string): WorkerInfo => ({
  id, kind: 'agent', deskId: `desk-${id}`, name, color, status, processState: 'running', acked: false, createdBy: 'Founder', createdAt: now,
  cols: 90, rows: 25, viewers: [], task: { name: task, summary: 'Synthetic review data' },
} as WorkerInfo);
store.workers = new Map([
  worker('w1', 'Pixel', '#54bab6', 'working', 'Café menu specials'),
  worker('w2', 'Nova', '#e9b949', 'needs_input', 'Lobby lights'),
  worker('w3', 'Atlas', '#9d4edd', 'done', 'Outreach docs'),
].map((w) => [w.id, w]));
store.issues = { items: issues, fetchedAt: now - 60_000, loading: false };
store.pulls = { items: pulls, fetchedAt: now - 60_000, loading: false };
store.empire.setup = { completed: true, selected: ['cafe'], completedAt: now };
store.empire.office = { floors: 2, workstations: 20 };
store.empire.funds = 48_250;

const net = { send: () => {} } as unknown as Net;
const actions: BoardActions = { assign() {}, ask() {}, goToDesk() {}, queue() {} };
const picture = { id: 'p1', url: '/assets/review-picture.svg', title: 'Harbour at dusk', wall: 'north', u: 0, y: 1.6, w: 1.2, h: 0.8, frame: 0, by: 'Founder', at: now };
const dialogs: Record<string, () => void> = {
  issues: () => openBoard('issues', net, actions),
  pulls: () => openBoard('pulls', net, actions),
  pull: () => openPull(pulls[0], net, actions),
  merge: () => { openPull(pulls[0], net, actions); setTimeout(() => (document.querySelector('.gh-mergebox-go .btn') as HTMLElement | null)?.click(), 600); },
  issue: () => openIssue(issues[0], actions),
  ask: () => openAsk({ title: 'Ask a worker', newDesk: 'Desk 5', workers: [...store.workers.values()].map(({ id, name, color, status }) => ({ id, name, color, status })), worktreeOption: true, context: 'Issue #41: Café menu board should show today’s specials', onSubmit() {} } as never),
  hang: () => openHangDialog({ onDone() {} }),
  picture: () => openPicture(picture as never, { move() {}, edit() {}, remove() {} }),
  workers: () => openWorkersDialog(() => {}),
  tower: () => new Tower(net, { pos: { x: 0, z: 100 }, scripted: false } as never, { floor: 0, setFloor() {}, setElevation() {} } as never, () => {}).open(),
  viewer: () => {
    // main.ts's screen viewer markup, with a canvas stream standing in for a shared screen.
    const canvas = Object.assign(document.createElement('canvas'), { width: 1280, height: 720 });
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#1e2a33'; ctx.fillRect(0, 0, 1280, 720); ctx.fillStyle = '#e6ecea'; ctx.font = '48px system-ui'; ctx.fillText('Shared screen (synthetic)', 380, 370);
    const video = h('video', { autoplay: true, playsinline: true, muted: true }) as HTMLVideoElement;
    video.srcObject = canvas.captureStream(5);
    const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
    const el = h('div.modal.viewer.ae-dark', { role: 'dialog', 'aria-label': 'Screen share' }, h('header', {}, h('h2', {}, '🖥️ Pixel’s screen'), close), video);
    const modal = openModal(el);
    close.addEventListener('click', () => modal.close());
  },
};
const name = new URLSearchParams(location.search).get('d') ?? 'issues';
(dialogs[name] ?? dialogs.issues)();
