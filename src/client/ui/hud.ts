import { DEFAULT_KEYS, keyLabel, type KeyBindings } from '../controls';
import { store } from '../state';
import type { Voice } from '../voice';
import { $, h, openModal, STATUS_LABEL } from './dom';
import { fmtCost, usageTitle } from './usage';
import { workerPill } from './status';

/** Makes a list row act like a button for the keyboard too: Tab to it, Enter or Space to press it. */
function pressable(li: HTMLElement, onPress: () => void) {
  li.tabIndex = 0;
  li.setAttribute('role', 'button');
  li.addEventListener('click', onPress);
  li.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onPress();
  });
}

/** Rows are rebuilt on every update; put keyboard focus back on the row that had it. */
function refocus(ul: HTMLElement, attr: string, id: string | undefined) {
  if (id) ul.querySelector<HTMLElement>(`li[${attr}="${CSS.escape(id)}"]`)?.focus();
}

export function renderPeople(voice: Voice, onEditProfile: () => void) {
  const ul = $('people');
  const focused = ul.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.peer : undefined;
  ul.replaceChildren();
  const peers = [...store.peers.values()].sort((a, b) => (a.id === store.you ? -1 : b.id === store.you ? 1 : a.name.localeCompare(b.name)));
  for (const p of peers) {
    const you = p.id === store.you;
    const mic = !p.voice ? '' : p.muted ? '🔇' : '🎙️';
    const li = h(
      'li',
      { 'data-peer': p.id, title: you ? 'Change your character' : p.name, style: you ? 'cursor:pointer' : '' },
      h('span.dot', { style: `background:${p.color}` }),
      h('span', {}, p.name),
      you ? h('span.you', {}, '(you)') : null,
      p.sharing ? h('span', { title: 'Sharing screen' }, '🖥️') : null,
      h('span.mic', {}, mic),
    );
    if (you) pressable(li, onEditProfile);
    ul.append(li);
  }
  refocus(ul, 'data-peer', focused);
  $('people-count').textContent = String(peers.length);
  void voice;
}

export function updateSpeaking(voice: Voice) {
  for (const li of document.querySelectorAll<HTMLElement>('#people li[data-peer]')) {
    const lvl = voice.levelOf(li.dataset.peer!);
    li.classList.toggle('speaking', lvl > 0.04);
  }
}

export function renderWorkers(onOpen: (id: string) => void) {
  const ul = $('workers');
  replaceKeepingFocus(ul, workerRows(onOpen));
  const workers = store.workers.size;
  $('worker-count').textContent = workers ? String(workers) : '';
}

/** Rebuilds a worker list without dropping keyboard focus from the row that had it. */
function replaceKeepingFocus(list: HTMLElement, rows: HTMLElement[]) {
  const active = document.activeElement as HTMLElement | null;
  const id = active && list.contains(active) ? active.closest<HTMLElement>('[data-worker]')?.dataset.worker : undefined;
  list.replaceChildren(...rows);
  if (!id) return;
  const again = [...list.querySelectorAll<HTMLElement>('[data-worker]')].find((el) => el.dataset.worker === id);
  (again ?? list.querySelector<HTMLElement>('[data-worker]') ?? list.closest<HTMLElement>('[tabindex]'))?.focus({ preventScroll: true });
}

function workerRows(onOpen: (id: string) => void): HTMLElement[] {
  const fresh = store.evidence().fresh;
  const workers = [...store.workers.values()].sort((a, b) => a.createdAt - b.createdAt);
  const rows = workers.map((w) => {
    const sub = [w.worktree && `🌿 ${w.worktree.branch}`, w.pr && `🔀 PR #${w.pr.number}`, w.activity || w.title || w.prompt].filter(Boolean).join(' · ');
    const pill = workerPill(w.status, STATUS_LABEL[w.status] ?? w.status, fresh);
    return h(
      'li',
      {
        onclick: () => onOpen(w.id),
        onkeydown: ((e: KeyboardEvent) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          onOpen(w.id);
        }) as EventListener,
        tabindex: 0,
        role: 'button',
        'data-worker': w.id,
        title: `Open ${w.name}'s terminal`,
        'aria-label': `${w.name}, ${w.kind === 'shell' ? 'shell' : 'agent'}, ${pill.spoken}. Open terminal.`,
      },
      h('span.dot', { style: `background:${w.color}` }),
      h('span.name', {}, w.name, sub ? h('span.sub', {}, sub) : null),
      w.usage?.calls ? h('span.cost', { title: usageTitle(w.usage) }, fmtCost(w.usage.cost)) : null,
      h('span.pill', { class: pill.tone, title: fresh ? undefined : 'No fresh update from the server; this is the last reported status.' }, pill.text),
    );
  });
  return rows.length ? rows : [h('li.empty', {}, 'Walk up to a desk and press E to hire one')];
}

/** The side panel is hidden on small screens; this keeps every worker and its attention state reachable. */
export function openWorkersDialog(onOpen: (id: string) => void) {
  const close = h('button.btn.close', { 'aria-label': 'Close workers' }, '✕');
  const list = h('ul.workers-list');
  const paint = () => replaceKeepingFocus(list, workerRows((id) => { modal.close(); onOpen(id); }));
  const offs = (['workers', 'freshness'] as const).map((topic) => store.on(topic, paint));
  const modal = openModal(
    h('div.modal.workers-modal.ae-dark', { role: 'dialog', 'aria-label': 'Workers' }, h('header', {}, h('h2', {}, 'Workers'), close), h('div.body.workers', {}, list)),
    { onClose: () => offs.forEach((off) => off()) },
  );
  close.addEventListener('click', () => modal.close());
  paint();
}

export function renderChat() {
  const log = $('chat-log');
  // Follow new messages only when already at the bottom, so scrolling back to read isn't yanked away.
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.replaceChildren(
    ...store.chat.slice(-60).map((c) => h('li', {}, h('b', { style: `color:${c.color}` }, c.name), ': ', c.text)),
  );
  if (atBottom) log.scrollTop = log.scrollHeight;
}

export function openHelp(keys: KeyBindings = DEFAULT_KEYS) {
  const rows: [string, string][] = [
    [[keys.forward,keys.left,keys.backward,keys.right].map(keyLabel).join(' '), `Walk (hold ${keyLabel(keys.run)} to run)`],
    [keyLabel(keys.jump), 'Jump'],
    [keyLabel(keys.map), 'Expand the minimap and set a destination waypoint'],
    [keyLabel(keys.camera), 'Switch between first person and third person'],
    ['Doors', 'Walk through entrances. Businesses require construction and an assigned AI worker.'],
    [keyLabel(keys.interact), 'Enter or exit your parked car at the driver’s door'],
    ['Mouse', 'Look around in first person (click to capture the mouse, Esc to free it)'],
    [`Click / ${keyLabel(keys.interact)}`, 'Use what you look at: hire a worker, open its terminal, read a board, watch the TV'],
    ['Drag / wheel', 'Orbit and zoom the camera in third person'],
    [keyLabel(keys.task), 'Prompt: give a task to a new or existing worker at the desk you face'],
    [keyLabel(keys.changes), 'Changes: what the worker at the desk you face changed — files and diff, commit, discard, open a PR'],
    [keyLabel(keys.shell), 'Open a shared shell (dev servers, git, tests) at an empty desk'],
    [keyLabel(keys.resume), 'Resume a sleeping worker'],
    [keyLabel(keys.dismiss), 'Send a worker home (frees the desk)'],
    [keyLabel(keys.decorate), 'Hang a picture from the web on a wall. Look at a picture and press E to move, edit or take it down'],
    [keyLabel(keys.open), 'Open a pull request for a worker on its own branch, or see the one it has'],
    [keyLabel(keys.chat), 'Chat'],
    [`${keyLabel(keys.voice)} / ${keyLabel(keys.mute)}`, 'Join voice / mute'],
    ['Esc', 'Close any window and get back to looking around'],
    ['`', 'Game menu: resume, map, management, settings, controls, sign out'],
    ['Ctrl + [', 'Send Esc to a terminal (e.g. to interrupt Claude)'],
    ['⚙️', 'Settings: remap controls, change camera and volume'],
  ];
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const el = h(
    'div.modal.game-help.ae-dark',
    { role: 'dialog', 'aria-label': 'Controls' },
    h('header', {}, h('h2', {}, '🎮 Controls'), close),
    h('div.body', {}, h('div.help-grid', {}, ...rows.flatMap(([k, v]) => [h('span.key', {}, k), h('span', {}, v)]))),
  );
  const modal = openModal(el);
  close.addEventListener('click', () => modal.close());
}
