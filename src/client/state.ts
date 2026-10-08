import { DEFAULT_KEYS, sanitizeKeys, type KeyBindings } from './controls';
import { initialEmpire } from '../shared/empire';
import { cloudEvidence, evidence } from './ui/status';
import type { CloudInfo } from './cloud/types';
import { parseContinuity } from './ui/continuity';
import type { ContinuityStatus } from '../shared/continuity';
import type { ChatLine, GhIssue, GhPull, GhState, PeerInfo, ProjectInfo, QueueState, QueueTask, ServerMsg, ServicesState, TeamState, UpgradeState, Usage, UsageState, WorkerInfo } from '../shared/protocol';
import type { ScreenState } from './world/laptop';
import { randomLook, sanitizeLook, type Look } from '../shared/avatar';
import type { Decoration } from '../shared/decor';
import type { OrgState } from '../shared/org';

type Topic = 'cloud' | 'empire' | 'peers' | 'workers' | 'issues' | 'pulls' | 'chat' | 'project' | 'screens' | 'team' | 'upgrade' | 'services' | 'decor' | 'usage' | 'queue' | 'connection' | 'freshness' | 'continuity' | 'org';

const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, calls: 0 });

export interface Profile {
  name: string;
  color: string;
  look: Look;
}

const PROFILE_KEY = 'agent-office.profile';
export const AVATAR_COLORS = ['#ff8a5b', '#4f86f7', '#06d6a0', '#ef476f', '#ffd166', '#9d4edd', '#00b4d8', '#f77f00'];

/** Your saved profile. `look` is missing if you joined before there was a character select screen. */
export function loadProfile(): (Omit<Profile, 'look'> & { look?: Look }) | null {
  try {
    const p = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? 'null');
    if (p && typeof p.name === 'string' && typeof p.color === 'string') {
      return { name: p.name, color: p.color, look: p.look ? sanitizeLook(p.look, randomLook()) : undefined };
    }
  } catch {
    // storage blocked
  }
  return null;
}

export function saveProfile(p: Profile) {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
  } catch {
    // storage blocked
  }
}

import { sanitizeQuality, type GraphicsQuality } from './graphics';

export type ViewMode = 'first' | 'third';

export interface Settings {
  quality: GraphicsQuality;
  keys: KeyBindings;
  view: ViewMode;
  /** Office sounds, 0–1. */
  volume: number;
  muted: boolean;
}

const SETTINGS_KEY = 'agent-office.settings';

export function loadSettings(): Settings {
  const s: Settings = { quality: 'medium', view: 'third', volume: 0.7, muted: false, keys: { ...DEFAULT_KEYS } };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    s.keys = sanitizeKeys(saved?.keys);
    s.quality = sanitizeQuality(saved?.quality);
    if (saved?.view === 'first' || saved?.view === 'third') s.view = saved.view;
    if (typeof saved?.volume === 'number' && Number.isFinite(saved.volume)) s.volume = Math.max(0, Math.min(1, saved.volume));
    if (typeof saved?.muted === 'boolean') s.muted = saved.muted;
  } catch {
    // storage blocked
  }
  return s;
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // storage blocked
  }
}

/** The worker whose worktree branch a pull request came from, if it is still at a desk. */
export function workerForPull(workers: Iterable<WorkerInfo>, pr: { number: number; headRefName: string }): WorkerInfo | undefined {
  for (const w of workers) if (w.pr?.number === pr.number || (w.worktree && w.worktree.branch === pr.headRefName)) return w;
  return undefined;
}

class Store {
  empire = initialEmpire();
  /** performance.now() when the last empire message arrived; 0 before the first. */
  empireReceivedAt = 0;
  connected = false;
  /** navigator.onLine: false means this device has no network, not that the host is down. */
  online = typeof navigator === 'undefined' ? true : navigator.onLine;
  continuity: ContinuityStatus | null = null;
  /** performance.now() when the last continuity status arrived; 0 before the first. */
  continuityReceivedAt = 0;
  /** performance.now() when the current socket opened; earlier reports belong to a previous connection. */
  connectedAt = 0;
  you = '';
  profile: Profile = { name: 'Guest', color: AVATAR_COLORS[1], look: randomLook() };
  peers = new Map<string, PeerInfo>();
  workers = new Map<string, WorkerInfo>();
  screens = new Map<string, ScreenState>();
  project: ProjectInfo | null = null;
  issues: GhState<GhIssue> = { items: [], fetchedAt: 0, loading: true };
  pulls: GhState<GhPull> = { items: [], fetchedAt: 0, loading: true };
  ice: RTCIceServer[] = [];
  chat: ChatLine[] = [];
  /** Whether this office can invite teammates (deployed with deploy/aws.sh). */
  invites = false;
  team: TeamState | null = null;
  upgrade: UpgradeState = { available: false, phase: 'idle' };
  services: ServicesState = { items: [], port: 4600 };
  /** Pictures on the walls. */
  decor: Decoration[] = [];
  usage: UsageState = { total: zeroUsage(), today: zeroUsage(), day: '', pauseHiring: false };
  queue: QueueState = { tasks: [], maxWorkers: 0 };
  /** The rule-based executive roster (ORG-01); null until a server that has one says so. */
  org: OrgState | null = null;
  /** Cloud mode only: the state-repository snapshot this game is showing, with its age. Null in server mode. */
  cloud: CloudInfo | null = null;
  private subs = new Map<Topic, Set<() => void>>();

  on(topic: Topic, fn: () => void) {
    let set = this.subs.get(topic);
    if (!set) this.subs.set(topic, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit(topic: Topic) {
    this.subs.get(topic)?.forEach((fn) => fn());
  }

  setConnected(up: boolean) {
    if (this.connected === up) return;
    this.connected = up;
    if (up) this.connectedAt = performance.now();
    // A new socket must receive its own snapshot before cached evidence becomes live again.
    if (!up) this.empireReceivedAt = 0;
    this.emit('connection');
    this.checkFreshness();
  }

  setCloud(info: CloudInfo) {
    this.cloud = info;
    this.emit('cloud');
    this.checkFreshness();
  }

  evidence(now = performance.now()) {
    // Cloud mode: everything comes from a committed snapshot, so nothing is ever "fresh" (live).
    if (this.cloud) return cloudEvidence(this.cloud.snapshot?.state.heartbeat.lastRunAt ?? this.cloud.snapshot?.state.meta.createdAt, Date.now());
    return evidence(this.empire.supervision, this.connected, this.empireReceivedAt, now, this.connectedAt > 0);
  }

  setOnline(online: boolean) {
    if (this.online === online) return;
    this.online = online;
    this.emit('connection');
  }

  /** Takes a status from the socket or /api/continuity/status; malformed input is ignored. */
  setContinuity(value: unknown) {
    const status = parseContinuity(value);
    if (!status) return;
    this.continuity = status;
    this.continuityReceivedAt = performance.now();
    this.emit('continuity');
  }

  private wasFresh = false;
  /** Emits 'freshness' when evidence becomes fresh or goes stale; call periodically, since staleness arrives without a message. */
  checkFreshness() {
    const fresh = this.evidence().fresh;
    if (fresh === this.wasFresh) return;
    this.wasFresh = fresh;
    this.emit('freshness');
  }

  workerAtDesk(deskId: string): WorkerInfo | undefined {
    for (const w of this.workers.values()) if (w.deskId === deskId) return w;
    return undefined;
  }

  /** The queue task for an issue: the one on the queue if there is one, else the latest finished one. */
  taskForIssue(issue: number): QueueTask | undefined {
    const tasks = this.queue.tasks.filter((t) => t.issue === issue);
    return tasks.find((t) => t.status !== 'done') ?? tasks[tasks.length - 1];
  }

  apply(msg: ServerMsg) {
    switch (msg.t) {
      case 'continuity.status':
        this.setContinuity(msg.status);
        break;
      case 'empire':
        this.empire = msg.state;
        this.empireReceivedAt = performance.now();
        this.emit('empire');
        this.checkFreshness();
        break;
      case 'welcome':
        this.you = msg.you;
        this.peers = new Map(msg.peers.map((p) => [p.id, p]));
        this.workers = new Map(msg.workers.map((w) => [w.id, w]));
        this.screens.clear(); // fresh full frames follow the welcome
        this.project = msg.project;
        this.issues = msg.issues;
        this.pulls = msg.pulls;
        this.ice = msg.ice as RTCIceServer[];
        this.chat = msg.chat;
        this.invites = msg.invites;
        this.upgrade = msg.upgrade;
        this.services = msg.services;
        this.decor = msg.decor;
        this.usage = msg.usage;
        this.queue = msg.queue;
        this.org = msg.org ?? null;
        for (const t of ['peers', 'workers', 'issues', 'pulls', 'chat', 'project', 'upgrade', 'services', 'decor', 'usage', 'queue', 'org'] as Topic[]) this.emit(t);
        break;
      case 'peer.join':
      case 'peer.update':
        this.peers.set(msg.peer.id, msg.peer);
        this.emit('peers');
        break;
      case 'peer.move': {
        const p = this.peers.get(msg.id);
        if (p) Object.assign(p, { x: msg.x, y: msg.y, z: msg.z, rotY: msg.rotY, moving: msg.moving });
        break;
      }
      case 'peer.leave':
        this.peers.delete(msg.id);
        this.emit('peers');
        break;
      case 'worker.update':
        this.workers.set(msg.worker.id, msg.worker);
        this.emit('workers');
        break;
      case 'worker.remove':
        this.workers.delete(msg.workerId);
        this.screens.delete(msg.workerId);
        this.emit('workers');
        break;
      case 'screen': {
        let s = this.screens.get(msg.workerId);
        if (!s || msg.full || s.cols !== msg.cols || s.rows !== msg.rows) {
          s = { cols: msg.cols, rows: msg.rows, lines: [], cursor: msg.cursor, version: (s?.version ?? 0) + 1 };
          this.screens.set(msg.workerId, s);
        }
        for (const [k, v] of Object.entries(msg.lines)) s.lines[Number(k)] = v;
        s.cursor = msg.cursor;
        s.version++;
        this.emit('screens');
        break;
      }
      case 'gh.issues':
        this.issues = msg.state;
        this.emit('issues');
        break;
      case 'gh.pulls':
        this.pulls = msg.state;
        this.emit('pulls');
        break;
      case 'team':
        this.team = msg.state;
        this.emit('team');
        break;
      case 'upgrade':
        this.upgrade = msg.state;
        this.emit('upgrade');
        break;
      case 'services':
        this.services = msg.state;
        this.emit('services');
        break;
      case 'decor':
        this.decor = msg.items;
        this.emit('decor');
        break;
      case 'usage':
        this.usage = msg.state;
        this.emit('usage');
        break;
      case 'queue':
        this.queue = msg.state;
        this.emit('queue');
        break;
      case 'org':
        this.org = msg.state;
        this.emit('org');
        break;
      case 'chat':
        this.chat.push(msg);
        if (this.chat.length > 200) this.chat.shift();
        this.emit('chat');
        break;
    }
  }
}

export const store = new Store();
