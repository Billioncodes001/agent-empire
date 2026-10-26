/**
 * CLOUD-04: the app's view of the Empire's private state repository, through api.github.com only.
 *
 * Reading: the branch head is polled with a conditional request (`If-None-Match` on the ref's ETag). An unchanged
 * head answers 304, which GitHub does not count against the rate limit. When the head moves, the commit and its tree
 * are read and only the `state/*` blobs whose sha changed are downloaded (blobs are immutable, so they are cached by
 * sha). Pending intents are counted from the tree; their bodies are never fetched.
 *
 * Writing: a client never writes `state/`. Every action is one new file `intents/<uuidv7>.json`, validated with the
 * coordinator's own parser before it leaves the device, created with the Contents API, then a `repository_dispatch`
 * wakes the coordinator. Requests use `cache: 'no-store'` (GitHub marks GETs cacheable for 60 s) and never cookies.
 * Error messages never include the token.
 */
import { intentPath, parseIntent, type CloudIntent } from '../../cloud/intents';
import { INTENT_PATH, OPTIONAL_STATE_FILES, parseStateFiles, STATE_PATHS, type CloudState } from '../../cloud/schema';
import { encodeBase64Utf8, GitHubClient } from '../../cloud/store';
import { checkStateSecrets } from '../../cloud/actions-setup';
import { WORKFLOW_FILE } from '../../cloud/workflow';
import { uuidv7 } from './uuid';
import { githubApiBase } from './api-base';
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const MAX_STATE_FILE = 4 * 1024 * 1024;

export type RepoErrorCode = 'unauthorized' | 'forbidden' | 'rate_limited' | 'not_found' | 'offline' | 'github' | 'invalid_state' | 'conflict' | 'invalid';
export class RepoError extends Error {
  constructor(readonly code: RepoErrorCode, message: string, readonly status = 0) {
    super(message);
    this.name = 'RepoError';
  }
}

export interface RepoRef {
  owner: string;
  name: string;
}
export function parseRepo(text: string | null | undefined): RepoRef | null {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec((text ?? '').trim());
  if (!m || !OWNER.test(m[1]) || !NAME.test(m[2]) || m[2] === '.' || m[2] === '..') return null;
  return { owner: m[1], name: m[2] };
}
export const repoLabel = (r: RepoRef) => `${r.owner}/${r.name}`;

/** One state-repository read. `files` are the raw state files (kept so a relaunch can show them immediately). */
export interface Snapshot {
  sha: string;
  state: CloudState;
  files: Record<string, string>;
  /** Intent ids still waiting in `intents/` (written by any device, not yet consumed by the coordinator). */
  pending: string[];
  /** Device clock (ms) when this snapshot was read from GitHub. */
  readAt: number;
}

export type PollResult = { changed: false; checkedAt: number } | { changed: true; checkedAt: number; snapshot: Snapshot };
export type DispatchType = 'agent-empire-intent' | 'agent-empire-start' | 'agent-empire-shutdown';
/** An intent as the app builds it; id and createdAt are added when it is submitted. */
export type IntentBody = CloudIntent extends infer I ? (I extends CloudIntent ? Omit<I, 'id' | 'createdAt' | 'schemaVersion'> : never) : never;

function friendly(status: number, message: string): RepoError {
  if (status === 401) return new RepoError('unauthorized', 'GitHub no longer accepts this sign-in. It may have expired or been revoked; link GitHub again.', status);
  if ((status === 403 || status === 429) && /rate limit/i.test(message)) return new RepoError('rate_limited', 'GitHub’s rate limit was reached. The app will try again in a few minutes.', status);
  if (status === 403) return new RepoError('forbidden', 'GitHub refused this. The token may be missing a permission (Contents, Actions or Workflows read and write).', status);
  if (status === 404) return new RepoError('not_found', 'GitHub can’t find the state repository, or this token can’t see it.', status);
  if (status === 409 || status === 422) return new RepoError('conflict', 'The state repository changed at the same moment. Try again.', status);
  return new RepoError('github', status >= 500 ? 'GitHub is having trouble. The app will try again shortly.' : `GitHub answered with an error (${status}).`, status);
}

export class CloudRepo {
  private etag = '';
  private headSha = '';
  private branch: string | null;
  private blobs = new Map<string, string>();
  private last: Snapshot | null = null;

  constructor(
    readonly repo: RepoRef,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly base = githubApiBase(),
    branch?: string,
  ) {
    if (!parseRepo(repoLabel(repo))) throw new RepoError('invalid', 'Invalid state repository.');
    if (!token || /\s/.test(token)) throw new RepoError('unauthorized', 'Link GitHub to open your Empire.');
    this.branch = branch ?? null;
  }

  /** FREE-11/12: which Actions secret NAMES exist in the state repository (names only; values are never read). */
  async secretNames(names: readonly string[]): Promise<{ present: Record<string, boolean>; error?: string }> {
    return checkStateSecrets(new GitHubClient(this.token, { fetch: this.fetchImpl, apiBase: this.base, browser: true }), { owner: this.repo.owner, name: this.repo.name }, names);
  }

  private async call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; data: any; etag: string | null }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/repos/${this.repo.owner}/${this.repo.name}${path}`, {
        method,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...extra,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new RepoError('offline', 'Can’t reach GitHub. Check this device’s connection.');
    }
    if (res.status === 304) return { status: 304, data: null, etag: res.headers.get('etag') };
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) throw friendly(res.status, typeof data?.message === 'string' ? data.message : '');
    return { status: res.status, data, etag: res.headers.get('etag') };
  }

  private async defaultBranch(): Promise<string> {
    if (this.branch) return this.branch;
    const { data } = await this.call('GET', '');
    if (data?.private !== true) throw new RepoError('invalid_state', 'The state repository is not private. Make it private on GitHub before using it.');
    const branch: string = typeof data.default_branch === 'string' && data.default_branch ? data.default_branch : 'main';
    this.branch = branch;
    return branch;
  }

  /** The last snapshot read by this object. */
  get snapshot() {
    return this.last;
  }

  /** Conditional read of the branch head; downloads and parses the state only when it moved. */
  async poll(now: () => number = Date.now): Promise<PollResult> {
    const branch = await this.defaultBranch();
    const ref = await this.call('GET', `/git/ref/heads/${branch}`, undefined, this.etag && this.last ? { 'If-None-Match': this.etag } : {});
    if (ref.status === 304 && this.last) return { changed: false, checkedAt: now() };
    const sha = ref.data?.object?.sha;
    if (typeof sha !== 'string' || !/^[a-f0-9]{40,64}$/.test(sha)) throw new RepoError('github', 'GitHub returned an invalid branch head.');
    if (sha === this.headSha && this.last) {
      this.etag = ref.etag ?? '';
      return { changed: false, checkedAt: now() };
    }
    const commit = await this.call('GET', `/git/commits/${sha}`);
    const treeSha = commit.data?.tree?.sha;
    if (typeof treeSha !== 'string') throw new RepoError('github', 'GitHub returned an invalid commit.');
    const tree = await this.call('GET', `/git/trees/${treeSha}?recursive=1`);
    if (tree.data?.truncated) throw new RepoError('invalid_state', 'The state repository is too large to read in one request.');
    const entries: { path: string; sha: string; size?: number }[] = (Array.isArray(tree.data?.tree) ? tree.data.tree : []).filter(
      (e: any) => e?.type === 'blob' && typeof e.path === 'string' && typeof e.sha === 'string',
    );
    const wanted = new Set<string>(STATE_PATHS);
    const files: Record<string, string> = {};
    // FREE-07 re-review: an optional state file (org.json) the app can't read is quarantined like the coordinator does.
    const unreadable: Record<string, string> = {};
    for (const entry of entries.filter((e) => wanted.has(e.path))) {
      const optional = OPTIONAL_STATE_FILES.includes(entry.path);
      if (entry.size !== undefined && entry.size > MAX_STATE_FILE) {
        if (optional) { unreadable[entry.path] = `${entry.path} is larger than ${MAX_STATE_FILE / 1024 / 1024} MiB`; continue; }
        throw new RepoError('invalid_state', `${entry.path} is larger than the app can read.`);
      }
      try { files[entry.path] = this.blobs.get(entry.sha) ?? (await this.blob(entry.sha)); }
      catch (error) { if (optional && error instanceof RepoError && error.code === 'invalid_state') unreadable[entry.path] = `${entry.path} is not UTF-8 text`; else throw error; }
    }
    const pending = entries
      .map((e) => INTENT_PATH.exec(e.path)?.[1])
      .filter((id): id is string => !!id)
      .map((id) => id.toLowerCase())
      .sort();
    const snapshot = this.parse(sha, files, pending, now(), unreadable);
    // Keep only the blobs this snapshot uses; the cache never grows past one state.
    const used = new Set(entries.filter((e) => wanted.has(e.path)).map((e) => e.sha));
    for (const key of [...this.blobs.keys()]) if (!used.has(key)) this.blobs.delete(key);
    this.headSha = sha;
    this.etag = ref.etag ?? '';
    this.last = snapshot;
    return { changed: true, checkedAt: snapshot.readAt, snapshot };
  }

  private async blob(sha: string): Promise<string> {
    const { data } = await this.call('GET', `/git/blobs/${sha}`);
    if (data?.encoding !== 'base64' || typeof data?.content !== 'string') throw new RepoError('github', 'GitHub returned an unsupported file.');
    let text: string;
    try {
      const bin = atob(data.content.replace(/\s/g, ''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new RepoError('invalid_state', 'A state file is not text.');
    }
    this.blobs.set(sha, text);
    return text;
  }

  /** Parses raw state files with the coordinator's rules. Also used for a snapshot saved on this device. */
  parse(sha: string, files: Record<string, string>, pending: string[], readAt: number, unreadable: Record<string, string> = {}): Snapshot {
    try {
      const { state } = parseStateFiles(files, readAt, unreadable);
      return { sha, state, files, pending, readAt };
    } catch (error) {
      const msg = error instanceof Error ? error.message : '';
      if (/not initialized/.test(msg)) throw new RepoError('invalid_state', 'The state repository has no Empire yet. Run “Create my Empire” in setup again; it continues where it stopped.');
      if (/newer coordinator/.test(msg)) throw new RepoError('invalid_state', 'Your Empire was saved by a newer coordinator. Update this app to open it.');
      throw new RepoError('invalid_state', `The Empire’s state could not be read (${msg.slice(0, 120)}).`);
    }
  }

  /**
   * Adds `intents/<uuidv7>.json` and wakes the coordinator. The intent is validated with the coordinator's own parser
   * first, so a malformed action never reaches GitHub. Returns the intent id.
   */
  async submit(body: IntentBody, wake: DispatchType = 'agent-empire-intent', now: number = Date.now()): Promise<{ id: string; dispatched: boolean }> {
    const branch = await this.defaultBranch();
    const id = uuidv7(now);
    const intent = { schemaVersion: 1, id, createdAt: now, ...body } as CloudIntent;
    const path = intentPath(id);
    const content = `${JSON.stringify(intent, null, 2)}\n`;
    try {
      parseIntent(path, content);
    } catch (error) {
      throw new RepoError('invalid', error instanceof Error ? error.message : 'This action is not valid.');
    }
    const b64 = encodeBase64Utf8(content);
    for (let attempt = 1; ; attempt++) {
      try {
        await this.call('PUT', `/contents/${path}`, { message: `Agent Empire intent ${intent.kind} ${id}`, content: b64, branch });
        break;
      } catch (error) {
        // A coordinator commit landing at the same moment answers 409; the id is new, so retrying cannot duplicate.
        if (error instanceof RepoError && error.status === 409 && attempt < 4) {
          await new Promise((r) => setTimeout(r, 400 * attempt));
          continue;
        }
        throw error;
      }
    }
    return { id, dispatched: await this.dispatch(wake) };
  }

  /** Wakes the coordinator. Optional: the schedule also picks intents up, so a failure here is not an error. */
  async dispatch(type: DispatchType): Promise<boolean> {
    try {
      await this.call('POST', '/dispatches', { event_type: type });
      return true;
    } catch {
      return false;
    }
  }

  /** The head commit's tree as {path → {sha, size}}. */
  private async headTree(): Promise<{ commit: string; tree: string; entries: Map<string, { sha: string; size?: number }> }> {
    const branch = await this.defaultBranch();
    const ref = await this.call('GET', `/git/ref/heads/${branch}`);
    const commit = ref.data?.object?.sha;
    if (typeof commit !== 'string' || !/^[a-f0-9]{40,64}$/.test(commit)) throw new RepoError('github', 'GitHub returned an invalid branch head.');
    const c = await this.call('GET', `/git/commits/${commit}`);
    const tree = c.data?.tree?.sha;
    if (typeof tree !== 'string') throw new RepoError('github', 'GitHub returned an invalid commit.');
    const t = await this.call('GET', `/git/trees/${tree}?recursive=1`);
    const entries = new Map<string, { sha: string; size?: number }>();
    for (const e of Array.isArray(t.data?.tree) ? t.data.tree : []) if (e?.type === 'blob' && typeof e.path === 'string' && typeof e.sha === 'string') entries.set(e.path, { sha: e.sha, size: e.size });
    return { commit, tree, entries };
  }

  /**
   * REL-05: which coordinator the state repository runs. `manifest` is coordinator/coordinator.json (written when the
   * app updates the coordinator); without one, the bundle itself is read so its sha256 can be compared.
   */
  async coordinatorInfo(paths: { bundle: string; manifest: string }): Promise<{ manifest: string | null; bundle: string | null }> {
    const head = await this.headTree();
    const read = async (path: string, max: number) => {
      const e = head.entries.get(path);
      if (!e) return null;
      if (e.size !== undefined && e.size > max) throw new RepoError('invalid_state', `${path} is larger than the app can read.`);
      return this.blobs.get(e.sha) ?? (await this.blob(e.sha));
    };
    const manifest = await read(paths.manifest, 64 * 1024);
    return { manifest, bundle: manifest ? null : await read(paths.bundle, 6 * 1024 * 1024) };
  }

  /**
   * Commits `files` in one commit on top of the current head (Git Data API, never forced). A concurrent coordinator
   * commit is retried on the new head; files outside `files` are never touched. Returns the new commit sha.
   */
  async commitFiles(files: { path: string; content: string }[], message: string): Promise<string> {
    const branch = await this.defaultBranch();
    for (let attempt = 1; ; attempt++) {
      const head = await this.headTree();
      const tree = await this.call('POST', '/git/trees', { base_tree: head.tree, tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })) });
      const commit = await this.call('POST', '/git/commits', { message, tree: tree.data?.sha, parents: [head.commit] });
      try {
        await this.call('PATCH', `/git/refs/heads/${branch}`, { sha: commit.data?.sha, force: false });
        return commit.data.sha as string;
      } catch (error) {
        if (error instanceof RepoError && error.code === 'conflict' && attempt < 4) {
          await new Promise((r) => setTimeout(r, 300 * attempt));
          continue;
        }
        throw error;
      }
    }
  }

  /** Start needs the workflow enabled again (shutdown disabled it); shutdown's last step may ask the app to disable it. */
  async setWorkflowEnabled(enabled: boolean): Promise<void> {
    await this.call('PUT', `/actions/workflows/${WORKFLOW_FILE}/${enabled ? 'enable' : 'disable'}`);
  }
}
