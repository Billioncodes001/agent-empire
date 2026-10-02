/**
 * REL-03: the client update service. Checks at launch, about every 6 hours while open, and from the menu. A check
 * fetches the signed channel file (through the shell: GitHub's release downloads send no CORS headers), verifies it
 * against the pinned key, and decides what to offer (decide.ts). Installing hands the verified URL, sha256 and version
 * to the shell (update.installGame); the shell switches bundles on restart and rolls back without a boot report.
 *
 * The service holds state and emits changes; ui.ts decides when the player sees them. Nothing here installs,
 * restarts or commits anything without an explicit call from the UI after the player accepted.
 */
import { isSemver } from './semver';
import { isChannel, type Channel, type ChannelFile } from './channel';
import { fetchChannel, SourceError, type Fetcher, type KeyValue } from './source';
import { decide, type Offer } from './decide';
import type { NativeInfo, UpdateBridge } from './bridge';
import { coordinatorDecision, commitCoordinatorUpdate, readInstalledCoordinator, type CoordinatorStatus } from './coordinator';
import type { CloudRepo } from '../cloud/repo';
import { sha256Hex } from './verify';

export const CHECK_EVERY_MS = 6 * 60 * 60_000;
const CHANNEL_KEY = 'agent-empire.update.channel';

declare const __AGENT_EMPIRE_GAME_VERSION__: string | undefined;
/** The game version this page was built as (vite define; tools/game-version). */
export function builtGameVersion(): string | null {
  const v = typeof __AGENT_EMPIRE_GAME_VERSION__ === 'string' ? __AGENT_EMPIRE_GAME_VERSION__ : null;
  return isSemver(v) ? v : null;
}

export type Phase = 'idle' | 'checking' | 'installing' | 'installed' | 'error';

export interface UpdateState {
  phase: Phase;
  channel: Channel;
  info: NativeInfo | null;
  /** The game version running in this page. */
  game: string | null;
  checkedAt: number | null;
  channelFile: ChannelFile | null;
  offer: Offer | null;
  error: string | null;
  /** Version installed and waiting for a restart. */
  installed: string | null;
  serverVersion: string | null;
  coordinator: CoordinatorStatus | null;
  coordinatorBusy: boolean;
}

export interface ServiceDeps {
  bridge: UpdateBridge | null;
  storage: KeyValue | null;
  /** Used without a shell (tests, the UI checks); a real browser can't read GitHub's release downloads. */
  fetcher?: Fetcher;
  now?: () => number;
  publicKey?: string;
  /** The bundled coordinator (same-origin), used instead of a download when it is the same file. */
  bundledCoordinator?: () => Promise<string | null>;
}

export class UpdateService {
  readonly state: UpdateState;
  private listeners = new Set<(s: UpdateState) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private cloud: Pick<CloudRepo, 'coordinatorInfo' | 'commitFiles'> | null = null;
  private now: () => number;

  constructor(private deps: ServiceDeps) {
    this.now = deps.now ?? Date.now;
    let channel: Channel = 'stable';
    try {
      const saved = deps.storage?.get(CHANNEL_KEY);
      if (isChannel(saved)) channel = saved;
    } catch {}
    this.state = { phase: 'idle', channel, info: null, game: builtGameVersion(), checkedAt: null, channelFile: null, offer: null, error: null, installed: null, serverVersion: null, coordinator: null, coordinatorBusy: false };
  }

  /** True when this app can check at all (a shell, or an injected fetcher in tests and checks). */
  get canCheck() {
    return !!this.deps.bridge || !!this.deps.fetcher;
  }

  on(fn: (s: UpdateState) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<UpdateState>) {
    Object.assign(this.state, patch);
    for (const fn of this.listeners) fn(this.state);
  }

  /** Reads the shell's versions, checks once now, then every 6 hours. */
  async start() {
    if (this.deps.bridge) {
      try {
        const info = await this.deps.bridge.nativeInfo();
        this.set({ info, game: info.installedGame ?? this.state.game, installed: info.pendingGame && info.pendingGame !== info.installedGame ? info.pendingGame : null });
      } catch (error) {
        this.set({ error: error instanceof Error ? error.message : 'The app did not report its version.' });
      }
    }
    if (!this.canCheck) return;
    this.timer ??= setInterval(() => void this.check(), CHECK_EVERY_MS);
    await this.check();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setChannel(channel: Channel) {
    if (!isChannel(channel) || channel === this.state.channel) return;
    try {
      this.deps.storage?.set(CHANNEL_KEY, channel);
    } catch {}
    this.set({ channel, offer: null, channelFile: null });
    void this.check();
  }

  /** Server mode: the version the connected server reports (shown, never changed). */
  setServerVersion(version: string | null | undefined) {
    const v = isSemver(version) ? version : null;
    if (v === this.state.serverVersion) return;
    this.set({ serverVersion: v, offer: this.state.channelFile ? decide(this.state.channelFile, { info: this.state.info, serverVersion: v }) : this.state.offer });
  }

  /** Cloud mode: the state repository whose coordinator may be updated (REL-05). */
  attachCloud(repo: Pick<CloudRepo, 'coordinatorInfo' | 'commitFiles'> | null) {
    this.cloud = repo;
    if (repo && this.state.channelFile) void this.refreshCoordinator();
  }

  /** One check; concurrent calls share it. Errors are kept in state, never thrown. */
  check(): Promise<void> {
    if (!this.canCheck) return Promise.resolve();
    this.running ??= this.runCheck().finally(() => (this.running = null));
    return this.running;
  }

  private fetcher(): Fetcher {
    const b = this.deps.bridge;
    if (b) return (url, etag) => b.fetch(url, etag);
    return this.deps.fetcher!;
  }

  private async runCheck() {
    if (this.state.phase === 'installing') return;
    this.set({ phase: 'checking', error: null });
    try {
      const found = await fetchChannel(this.state.channel, this.fetcher(), { cache: this.deps.storage, now: this.now(), publicKey: this.deps.publicKey });
      const channelFile = found?.file ?? null;
      const offer = channelFile ? decide(channelFile, { info: this.state.info, serverVersion: this.state.serverVersion }) : null;
      this.set({ phase: this.state.installed ? 'installed' : 'idle', checkedAt: this.now(), channelFile, offer });
      if (this.cloud && channelFile) await this.refreshCoordinator();
    } catch (error) {
      const message = error instanceof SourceError ? error.message : error instanceof Error ? error.message : 'The update check failed.';
      this.set({ phase: this.state.installed ? 'installed' : 'error', checkedAt: this.now(), error: message });
    }
  }

  private async refreshCoordinator() {
    const file = this.state.channelFile;
    if (!this.cloud || !file?.coordinator) return this.set({ coordinator: null });
    try {
      const installed = await readInstalledCoordinator(this.cloud);
      this.set({ coordinator: coordinatorDecision(file, installed) });
    } catch {
      // Reading GitHub failed (offline, rate limit): no coordinator prompt this time.
    }
  }

  /** The player accepted: download, verify and stage the game bundle (the shell does the work). */
  async installGame(): Promise<string> {
    const offer = this.state.offer?.game;
    const b = this.deps.bridge;
    if (!b || offer?.kind !== 'install') throw new Error('There is no game update to install.');
    this.set({ phase: 'installing', error: null });
    try {
      const { version } = await b.installGame({ url: offer.url, sha256: offer.sha256, version: offer.version });
      this.set({ phase: 'installed', installed: version, info: this.state.info ? { ...this.state.info, pendingGame: version } : null });
      return version;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The update could not be installed.';
      this.set({ phase: 'error', error: message });
      throw error;
    }
  }

  /** Restart into the installed bundle now (otherwise it starts on the next launch). */
  async restart() {
    if (!this.deps.bridge || !this.state.installed) throw new Error('No update is waiting.');
    await this.deps.bridge.activate();
  }

  /** The native app update, through the platform's own path. */
  async openNative() {
    const n = this.state.offer?.native;
    if (!this.deps.bridge || !n) throw new Error('There is no app update.');
    return this.deps.bridge.openNative(n.params);
  }

  /** REL-05: the player confirmed. Commits the new coordinator to the state repository. */
  async updateCoordinator(): Promise<string> {
    const c = this.state.coordinator;
    const file = this.state.channelFile;
    if (!this.cloud || c?.kind !== 'available' || !file?.coordinator) throw new Error('There is no coordinator update.');
    this.set({ coordinatorBusy: true });
    try {
      const sha = await commitCoordinatorUpdate(this.cloud, c, file.coordinator.schema, async () => {
        const bundled = await this.deps.bundledCoordinator?.().catch(() => null);
        if (bundled && (await sha256Hex(bundled)) === c.sha256) return bundled;
        if (!this.deps.bridge && !this.deps.fetcher) throw new Error('Update the app first: this browser can’t download the new coordinator.');
        const r = await this.fetcher()(c.url);
        if (r.status !== 200) throw new Error(`GitHub answered ${r.status} for the coordinator.`);
        return r.body;
      });
      this.set({ coordinator: { kind: 'current', installed: { version: c.version, sha256: c.sha256 } } });
      return sha;
    } finally {
      this.set({ coordinatorBusy: false });
    }
  }
}
