/**
 * CLOUD-04: the game's transport in cloud mode. It stands in for the server WebSocket (`Net`) so the city, HUD and
 * management are fed through the same store, but every value comes from the coordinator's last committed snapshot in
 * the user's GitHub state repository:
 *
 *   - On connect, the snapshot saved on this device is shown at once (labelled saved), then GitHub is read.
 *   - The branch head is polled every 60 s while the page is visible, immediately on focus / resume / coming back
 *     online, and every 15 s for a few minutes after this device sends an action. Hidden pages do not poll.
 *   - Game actions become intents (`intents/<uuidv7>.json`) plus a `repository_dispatch` wake-up. Actions that need a
 *     server (terminals, desks, tunnels, chat, voice, boards) are refused with an explanation instead of being sent.
 */
import { SPAWN } from '../../shared/layout';
import { SITES, type SiteId } from '../../shared/empire';
import { foundingJobId, type FoundingBrief } from './founding-plan';
import type { ClientMsg, PeerInfo, ServerMsg } from '../../shared/protocol';
import { Net } from '../net';
import { store, type Profile } from '../state';
import { toast } from '../ui/dom';
import { intentOutcome, toQueue, toUsage } from './map';
import { cloudApprovals, cloudExecutives, cloudResearch } from '../../cloud/org';
import { CloudRepo, RepoError, repoLabel, type DispatchType, type IntentBody, type Snapshot } from './repo';
import { loadSavedSnapshot, saveSnapshot, type CloudSession } from './session';
import type { CloudInfo, SentIntent } from './types';
import { uuidv7 } from './uuid';

export const POLL_VISIBLE_MS = 60_000;
export const POLL_FAST_MS = 15_000;
export const FAST_WINDOW_MS = 3 * 60_000;
const LOCAL_ID = 'cloud-you';

/**
 * The toast for an intent that failed to send. A lost connection or a GitHub server error may hide a write that did
 * land; for a paid job that matters, because assigning it again creates a second paid job under a new id.
 */
export function submitFailureMessage(kind: string, label: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : '';
  const unsure = error instanceof RepoError && (error.code === 'offline' || error.status >= 500);
  if (kind === 'new_job' && unsure)
    return `${label}: may not have been sent (${reason || 'GitHub didn’t answer'}). Check Cloud Empire → Jobs first: it may already be queued, and assigning it again would start a second paid job.`;
  return `${label}: not sent. ${reason}`.trim();
}
const CITY_ACTIONS = new Set(['delegate', 'found', 'build', 'hire', 'buy-land', 'upgrade', 'reinvest', 'office-floor', 'office-workstation', 'buy-plot', 'buy-vehicle', 'vehicle-spawn', 'vehicle-store', 'buy-helicopter']);

/** What each server-only message is, for the explanation shown instead of sending it. */
const SERVER_ONLY: [RegExp, string][] = [
  [/^(worker|term)\./, 'Workers at office desks and their live terminals'],
  [/^changes\./, 'Reviewing a desk worker’s file changes'],
  [/^gh\./, 'The issues and pull request boards'],
  [/^team\./, 'Inviting teammates to the office'],
  [/^upgrade\./, 'Upgrading the office server'],
  [/^decor\./, 'Pictures on the office walls'],
  [/^queue\./, 'Re-ordering the task queue'],
  [/^chat$/, 'Office chat'],
  [/^voice$|^rtc$/, 'Voice and screen sharing'],
];

export interface NewJobRequest { title: string; prompt: string; site?: string; /** FREE-07: a research question; sent as a `research` intent with the same paid confirmation. */ research?: string }
export interface CloudHooks {
  /** Opens the paid-job confirmation (cloud/ui.ts). */
  newJob?(request: NewJobRequest): void;
  /** Explains why a feature needs a server (cloud/ui.ts). */
  serverOnly?(feature: string): void;
}

export interface CloudNetDeps {
  fetch?: typeof fetch;
  apiBase?: string;
  now?: () => number;
  /** Visibility, so tests can drive it; defaults to document.visibilityState. */
  visible?: () => boolean;
  notify?: (text: string, level: 'info' | 'warn' | 'error') => void;
}

export class CloudNet extends Net {
  readonly repo: CloudRepo;
  readonly hooks: CloudHooks = {};
  private msgHandlers: ((msg: ServerMsg) => void)[] = [];
  private upHandlers: ((up: boolean) => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fastUntil = 0;
  private polling: Promise<void> | null = null;
  private stopped = false;
  private welcomed = false;
  private disableTried = false;
  private readonly now: () => number;
  private readonly visible: () => boolean;
  private readonly notify: (text: string, level: 'info' | 'warn' | 'error') => void;
  info: CloudInfo;

  constructor(readonly session: CloudSession, private readonly profileOf: () => Profile, deps: CloudNetDeps = {}) {
    super(profileOf);
    this.repo = new CloudRepo(session.repo, session.token, deps.fetch, deps.apiBase);
    this.now = deps.now ?? Date.now;
    this.notify = deps.notify ?? ((text, level) => toast(text, level));
    this.visible = deps.visible ?? (() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
    this.info = { repo: repoLabel(session.repo), snapshot: null, source: null, error: null, sent: [], busy: false };
  }

  override onMessage(h: (msg: ServerMsg) => void) {
    this.msgHandlers.push(h);
    return () => {
      this.msgHandlers = this.msgHandlers.filter((fn) => fn !== h);
    };
  }
  override onStatus(h: (up: boolean) => void) {
    this.upHandlers.push(h);
    return () => {
      this.upHandlers = this.upHandlers.filter((fn) => fn !== h);
    };
  }
  private emit(msg: ServerMsg) {
    for (const h of this.msgHandlers) h(msg);
  }
  private statusKnown = false;
  private setUp(up: boolean) {
    // The first answer is always reported, so the HUD's connection banner reflects an offline start too.
    if (this.up === up && this.statusKnown) return;
    this.statusKnown = true;
    this.up = up;
    this.upHandlers.forEach((h) => h(up));
  }

  override connect() {
    this.stopped = false;
    if (!this.welcomed) {
      this.welcomed = true;
      this.emit(this.welcome());
      const saved = loadSavedSnapshot(this.session.repo);
      if (saved) {
        try {
          this.show(this.repo.parse(saved.sha, saved.files, saved.pending, saved.readAt), 'saved');
        } catch {
          // A saved snapshot this app can't read is ignored; GitHub is read next.
        }
      }
      this.publish();
      if (typeof window !== 'undefined') {
        const wake = () => this.visible() && this.pollSoon();
        document.addEventListener('visibilitychange', wake);
        window.addEventListener('focus', wake);
        window.addEventListener('pageshow', wake);
        window.addEventListener('online', wake);
      }
    }
    void this.pollNow();
  }

  override reconnectNow() {
    void this.pollNow();
  }
  override expectRestart() {}

  /** Polls now unless a poll ran in the last 2 s (focus and visibility events often come together). */
  private lastPollStart = 0;
  pollSoon() {
    if (this.now() - this.lastPollStart < 2000) return;
    void this.pollNow();
  }

  pollNow(): Promise<void> {
    if (this.polling) return this.polling;
    this.stopped = false;
    this.lastPollStart = this.now();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.polling = (async () => {
      let delay = this.now() < this.fastUntil ? POLL_FAST_MS : POLL_VISIBLE_MS;
      try {
        const result = await this.repo.poll(this.now);
        this.info.checkedAt = result.checkedAt;
        this.info.error = null;
        if (result.changed) this.show(result.snapshot, 'github');
        this.setUp(true);
        await this.finishShutdownIfAsked();
      } catch (error) {
        const e = error instanceof RepoError ? error : new RepoError('github', 'Could not read your Empire from GitHub.');
        this.info.error = { code: e.code, message: e.message };
        // Reachable but refusing (auth, missing repo, unreadable state) is still "up": the banner is for the network.
        this.setUp(e.code !== 'offline');
        if (e.code === 'rate_limited') delay = 5 * 60_000;
        else if (e.code === 'offline') delay = 30_000;
        else if (e.code === 'unauthorized') delay = 10 * 60_000;
      } finally {
        this.polling = null;
        this.publish();
        this.schedule(delay);
      }
    })();
    return this.polling;
  }

  private schedule(delay: number) {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped) return;
    // A hidden page does not poll; becoming visible polls at once (connect() listens for it).
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.visible()) void this.pollNow();
      else this.schedule(POLL_VISIBLE_MS);
    }, delay);
  }

  /** Stops polling (tests, sign-out) until the next explicit poll or connect. */
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private show(snapshot: Snapshot, source: 'github' | 'saved') {
    const before = this.info.snapshot;
    this.info.snapshot = snapshot;
    this.info.source = source;
    if (source === 'github') saveSnapshot(this.session.repo, { sha: snapshot.sha, files: snapshot.files, pending: snapshot.pending, readAt: snapshot.readAt });
    // Actions this device sent: report the coordinator's verdict once it consumed them.
    if (source === 'github') {
      const still: SentIntent[] = [];
      for (const sent of this.info.sent) {
        const outcome = intentOutcome(snapshot.state, sent.id);
        if (outcome) {
          if (outcome.outcome === 'rejected') this.notify(`${sent.label}: not applied. ${outcome.message ?? ''}`.trim(), 'warn');
          else if (outcome.outcome === 'applied') this.notify(`${sent.label}: applied by your coordinator.`, 'info');
        } else if (snapshot.pending.includes(sent.id) || this.now() - sent.at < 10 * 60_000) still.push(sent);
      }
      this.info.sent = still;
    }
    if (before?.sha === snapshot.sha) return;
    const state = snapshot.state;
    this.emit({ t: 'empire', state: state.empire });
    this.emit({ t: 'queue', state: toQueue(state) });
    this.emit({ t: 'usage', state: toUsage(state, this.now()) });
    // FREE-07: the inbox, executives and research the coordinator recorded, in the shapes the server sends.
    this.emit({ t: 'approvals', state: cloudApprovals(state.org, state.meta.revision, state.orgError ? `Your organization file could not be read (${state.orgError}). Decisions are refused until state/org.json is repaired; the rest of the Empire keeps running.` : undefined) });
    this.emit({ t: 'org', state: cloudExecutives(state, state.org, snapshot.readAt) });
    this.emit({ t: 'research', state: cloudResearch(state.org, state.jobs.jobs) });
  }

  private publish() {
    store.setCloud({ ...this.info, sent: [...this.info.sent] });
  }

  /** The coordinator could not disable its own workflow after a shutdown: the app does it, once per session. */
  private async finishShutdownIfAsked() {
    const meta = this.info.snapshot?.state.meta;
    if (this.disableTried || !meta || meta.lifecycle.status !== 'shutdown' || meta.lifecycle.workflow !== 'disable_requested') return;
    this.disableTried = true;
    try {
      await this.repo.setWorkflowEnabled(false);
      this.notify('Shutdown finished: the coordinator workflow is disabled.', 'info');
    } catch (error) {
      this.notify(`Shutdown is recorded, but the workflow could not be disabled from this device (${error instanceof Error ? error.message : 'GitHub refused'}). Disable it on GitHub under Actions.`, 'warn');
    }
  }

  /**
   * Writes one intent and wakes the coordinator. Resolves with the intent id, or null when it was not sent (the
   * reason is shown as a toast).
   */
  async submit(body: IntentBody, label: string, wake: DispatchType = 'agent-empire-intent', opts: { quiet?: boolean } = {}): Promise<string | null> {
    if (this.info.busy) {
      this.notify('Still sending the previous action to GitHub…', 'warn');
      return null;
    }
    this.info.busy = true;
    this.publish();
    try {
      const { id, dispatched } = await this.repo.submit(body, wake, this.now());
      const jobId = 'jobId' in body ? body.jobId : 'job' in body ? body.job.id : undefined;
      // FREE-07: the inbox item or lesson an organization intent is about, so its panel shows "sent, waiting".
      const ref = 'approvalId' in body ? body.approvalId : 'lessonId' in body ? body.lessonId : undefined;
      this.info.sent.push({ id, kind: body.kind, label, at: this.now(), ...(jobId ? { jobId } : {}), ...(ref ? { ref } : {}) });
      if (!opts.quiet) this.notify(dispatched ? `${label}: sent. Your coordinator applies it on its next run, usually within a few minutes.` : `${label}: saved in your state repository. The coordinator applies it on its next scheduled run.`, 'info');
      this.fastUntil = this.now() + FAST_WINDOW_MS;
      return id;
    } catch (error) {
      this.notify(submitFailureMessage(body.kind, label, error), 'error');
      return null;
    } finally {
      this.info.busy = false;
      this.publish();
      // Read back soon, so the pending action shows; not after stop() (sign-out, tests).
      if (!this.stopped) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          if (!this.stopped) void this.pollNow();
        }, 1500);
      }
    }
  }

  /** Re-enables the workflow, then records the start intent (start is applied by the coordinator, so it must run). */
  async start(): Promise<string | null> {
    try {
      await this.repo.setWorkflowEnabled(true);
    } catch (error) {
      this.notify(`Start Empire: the coordinator workflow could not be enabled (${error instanceof Error ? error.message : 'GitHub refused'}). Nothing was changed.`, 'error');
      return null;
    }
    this.disableTried = false;
    return this.submit({ kind: 'start' }, 'Start Empire', 'agent-empire-start');
  }

  /**
   * Founding in cloud mode: the `found` city action, then one paid startup job per appointed manager, each a proper
   * `new_job` intent carrying `confirmPaid` and the `configRevision` the user saw. Called only after the founding
   * dialog's explicit paid-work confirmation (`briefs` is empty when execution is not configured: plan only).
   * Job ids are stable per Empire and site, so a repeated plan cannot queue or pay twice.
   */
  async found(sites: SiteId[], briefs: FoundingBrief[], configRevision: number): Promise<{ founded: boolean; queued: number; failed: string[] }> {
    const state = this.info.snapshot?.state;
    if (!state) {
      this.notify('Founding plan: your Empire hasn’t loaded from GitHub yet. Nothing was sent.', 'warn');
      return { founded: false, queued: 0, failed: briefs.map((b) => b.title) };
    }
    const founded = await this.submit({ kind: 'empire_action', action: { kind: 'found', sites } } as IntentBody, cityLabel('found'), 'agent-empire-intent', { quiet: briefs.length > 0 });
    if (!founded) return { founded: false, queued: 0, failed: briefs.map((b) => b.title) };
    let queued = 0;
    const failed: string[] = [];
    const repo = repoLabel(this.session.repo);
    for (const brief of briefs) {
      const id = await foundingJobId(repo, state, brief.site);
      const sent = await this.submit(
        { kind: 'new_job', job: { id, title: brief.title.slice(0, 120), prompt: brief.prompt, site: brief.site, configRevision, confirmPaid: true } },
        brief.title,
        'agent-empire-intent',
        { quiet: true },
      );
      if (sent) queued++;
      else failed.push(brief.title);
    }
    if (briefs.length) {
      this.notify(
        failed.length
          ? `Founding plan sent with ${queued} of ${briefs.length} startup jobs. ${failed.length} could not be sent; assign them from Management → Sectors.`
          : `Founding plan and ${queued} startup job${queued === 1 ? '' : 's'} sent. Your coordinator applies them on its next run, usually within a few minutes.`,
        failed.length ? 'warn' : 'info',
      );
    }
    return { founded: true, queued, failed };
  }

  /** A time-ordered id for a new job (the intent gets its own). */
  newJobId() {
    return uuidv7(this.now());
  }

  shutdown(): Promise<string | null> {
    return this.submit({ kind: 'shutdown' }, 'Shut down Empire', 'agent-empire-shutdown');
  }

  private explainedAt = new Map<string, number>();
  private explain(feature: string) {
    const last = this.explainedAt.get(feature) ?? 0;
    if (this.now() - last < 3000) return;
    this.explainedAt.set(feature, this.now());
    if (this.hooks.serverOnly) this.hooks.serverOnly(feature);
    else this.notify(`${feature} needs your own Agent Empire server. Cloud mode runs agents in the provider’s cloud and has no live office.`, 'info');
  }

  override send(msg: ClientMsg) {
    switch (msg.t) {
      case 'move':
      case 'act':
      case 'ping':
        return; // movement is local in cloud mode; nobody else is in this office
      case 'profile': {
        const peer = { ...this.localPeer(), name: msg.name, color: msg.color, look: msg.look };
        this.emit({ t: 'peer.update', peer });
        return;
      }
      case 'empire.action': {
        const action = msg.action;
        if (action.kind === 'retry-manager') {
          this.notify('In cloud mode a manager is retried by assigning its sector a new job: Management → Sectors → Assign real AI task.', 'info');
          return;
        }
        if (!CITY_ACTIONS.has(action.kind)) return;
        void this.submit({ kind: 'empire_action', action } as IntentBody, cityLabel(action.kind));
        return;
      }
      case 'queue.add': {
        // The sector dialog (ui/empire.ts) prefixes "Sector: <sector> / <site>"; keep that link as the job's site.
        const site = SITES.find((s) => msg.prompt.startsWith(`Sector: ${s.sector} / ${s.name}\n`));
        if (this.hooks.newJob) this.hooks.newJob({ title: msg.title ?? msg.prompt.slice(0, 90), prompt: msg.prompt, ...(site ? { site: site.id } : {}) });
        return;
      }
      case 'voice':
        if (!msg.voice && !msg.sharing) return; // leaving voice is a no-op here
        break;
    }
    const feature = SERVER_ONLY.find(([re]) => re.test(msg.t))?.[1];
    if (feature) this.explain(feature);
  }

  private localPeer(): PeerInfo {
    const p = this.profileOf();
    return { id: LOCAL_ID, name: p.name, color: p.color, look: p.look, x: SPAWN.x, y: 0, z: SPAWN.z, rotY: 0, moving: false, voice: false, muted: false, sharing: false };
  }

  private welcome(): ServerMsg {
    const unavailable = 'Needs your own Agent Empire server. Cloud mode has no live office board.';
    return {
      t: 'welcome',
      you: LOCAL_ID,
      peers: [this.localPeer()],
      workers: [],
      project: { name: 'Cloud Empire', dir: `github.com/${repoLabel(this.session.repo)}`, branch: undefined, agentCmd: 'cloud coordinator (GitHub Actions)' },
      issues: { items: [], fetchedAt: 0, loading: false, error: unavailable },
      pulls: { items: [], fetchedAt: 0, loading: false, error: unavailable },
      ice: [],
      chat: [],
      invites: false,
      version: 'cloud',
      upgrade: { available: false, phase: 'idle' },
      services: { items: [], port: 0 },
      decor: [],
      usage: store.usage,
      queue: store.queue,
    };
  }
}

function cityLabel(kind: string): string {
  return (
    {
      delegate: 'Oversight preference', found: 'Founding plan', build: 'Construction', hire: 'Hiring', 'buy-land': 'Land purchase',
      upgrade: 'Upgrade', reinvest: 'Reinvestment', 'office-floor': 'New office floor', 'office-workstation': 'New workstation',
      'buy-plot': 'Plot purchase', 'buy-vehicle': 'Vehicle purchase', 'vehicle-spawn': 'Vehicle brought out', 'vehicle-store': 'Vehicle stored', 'buy-helicopter': 'Helicopter purchase',
    } as Record<string, string>
  )[kind] ?? 'City action';
}
