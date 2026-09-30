/**
 * State repository storage. The GitHub implementation uses only `fetch` and the REST Git Data API:
 * a multi-file change becomes one tree + one commit, and the branch ref is moved with `force: false`,
 * so a concurrent writer makes the update fail (HTTP 422) instead of being overwritten. Callers retry
 * by re-reading and recomputing. Browser-safe: no Node built-ins.
 */
import { INTENT_PATH, STATE_FILES } from './schema.js';

export interface StateSnapshot {
  /** Commit the snapshot was read from; the optimistic-concurrency token. */
  sha: string;
  treeSha: string;
  /** `state/*.json` and up to `maxIntents` `intents/*.json` files, by path. */
  files: Record<string, string>;
  /** True when more intent files exist than were read; the rest wait for the next tick. */
  intentsTruncated: boolean;
}
export interface FileChange { path: string; content: string | null }
export type CommitResult = { ok: true; sha: string; changed: boolean } | { ok: false; reason: 'conflict' };
export interface StateStore {
  read(): Promise<StateSnapshot>;
  commit(base: Pick<StateSnapshot, 'sha' | 'treeSha'>, changes: FileChange[], message: string): Promise<CommitResult>;
}
/** CLOUD-05: shutdown disables the scheduled workflow; start re-enables it. */
export interface WorkflowControl {
  setWorkflowEnabled(enabled: boolean): Promise<void>;
}

export const isStatePath = (path: string) => (Object.values(STATE_FILES) as string[]).includes(path) || INTENT_PATH.test(path);

export class ConflictRetriesExhausted extends Error {
  constructor(attempts: number) { super(`The state branch kept moving; gave up after ${attempts} attempts.`); this.name = 'ConflictRetriesExhausted'; }
}

/**
 * Read → compute → commit, retrying from a fresh read when the ref moved. `build` must be a pure
 * function of the snapshot (plus data it already holds) so a retry cannot duplicate side effects.
 */
export async function updateWithRetry<T>(
  store: StateStore,
  build: (snapshot: StateSnapshot, attempt: number) => { changes: FileChange[]; message: string; value: T } | Promise<{ changes: FileChange[]; message: string; value: T }>,
  maxAttempts = 5,
): Promise<{ value: T; sha: string; attempts: number; changed: boolean }> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const snapshot = await store.read();
    const next = await build(snapshot, attempt);
    const result = await store.commit(snapshot, next.changes, next.message);
    if (result.ok) return { value: next.value, sha: result.sha, attempts: attempt, changed: result.changed };
  }
  throw new ConflictRetriesExhausted(maxAttempts);
}

// ---------------------------------------------------------------- base64 (UTF-8, browser-safe)

export function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
export function decodeBase64Utf8(value: string): string {
  const binary = atob(value.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

// ---------------------------------------------------------------- GitHub REST client

export class GitHubError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'GitHubError'; }
}
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/;
const WORKFLOW_FILE = /^[A-Za-z0-9_.-]{1,100}\.ya?ml$/;

/** Minimal authenticated REST client. Error messages never include the token or request bodies. */
export class GitHubClient {
  private transport: typeof fetch;
  private timeoutMs: number;
  private apiBase: string;
  constructor(private token: string, options: { fetch?: typeof fetch; timeoutMs?: number; apiBase?: string } = {}) {
    this.transport = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.apiBase = options.apiBase ?? 'https://api.github.com';
  }

  async request(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', route: string, body?: unknown): Promise<{ status: number; data: any }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const label = `${method} ${route.split('?')[0]}`;
    try {
      let response: Response;
      try {
        response = await this.transport(this.apiBase + route, {
          method, redirect: 'error', signal: controller.signal,
          headers: { authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Agent-Empire-Coordinator', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        throw new GitHubError(0, controller.signal.aborted ? 'github_timeout' : 'github_unreachable', `GitHub request ${label} did not complete.`);
      }
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new GitHubError(502, 'github_response_large', `GitHub response for ${label} was too large.`);
      let data: any = undefined;
      if (text) { try { data = JSON.parse(text); } catch { data = undefined; } }
      if (!response.ok) {
        const detail = typeof data?.message === 'string' ? `: ${data.message.slice(0, 160)}` : '';
        throw new GitHubError(response.status, 'github_http', `GitHub ${label} returned HTTP ${response.status}${detail}`);
      }
      return { status: response.status, data };
    } finally { clearTimeout(timer); }
  }
}

export interface GitHubRepoRef { owner: string; repo: string; branch: string; workflowFile?: string }
export function validateRepoRef(ref: GitHubRepoRef): GitHubRepoRef {
  if (!NAME.test(ref.owner) || ref.owner.length > 39 || !REPO_NAME.test(ref.repo) || ref.repo === '.' || ref.repo === '..' || !BRANCH.test(ref.branch) || ref.branch.includes('..') || ref.branch.endsWith('.lock')
    || (ref.workflowFile !== undefined && !WORKFLOW_FILE.test(ref.workflowFile))) throw new GitHubError(400, 'invalid_repository', 'Invalid state repository reference.');
  return ref;
}

export class GitHubStateStore implements StateStore, WorkflowControl {
  private base: string;
  constructor(private client: GitHubClient, private ref: GitHubRepoRef, private options: { maxIntents?: number; maxFileBytes?: number } = {}) {
    validateRepoRef(ref);
    this.base = `/repos/${ref.owner}/${ref.repo}`;
  }

  async read(): Promise<StateSnapshot> {
    const head = await this.client.request('GET', `${this.base}/git/ref/heads/${this.ref.branch}`);
    const sha = head.data?.object?.sha;
    if (typeof sha !== 'string' || !/^[a-f0-9]{40,64}$/.test(sha)) throw new GitHubError(502, 'github_invalid', 'GitHub returned an invalid branch head.');
    const commit = await this.client.request('GET', `${this.base}/git/commits/${sha}`);
    const treeSha = commit.data?.tree?.sha;
    if (typeof treeSha !== 'string') throw new GitHubError(502, 'github_invalid', 'GitHub returned an invalid commit.');
    const tree = await this.client.request('GET', `${this.base}/git/trees/${treeSha}?recursive=1`);
    if (tree.data?.truncated) throw new GitHubError(502, 'github_tree_truncated', 'The state repository tree is too large to read in one request.');
    const entries: { path: string; sha: string; size?: number }[] = (Array.isArray(tree.data?.tree) ? tree.data.tree : [])
      .filter((entry: any) => entry?.type === 'blob' && typeof entry.path === 'string' && typeof entry.sha === 'string' && isStatePath(entry.path));
    const state = entries.filter(entry => !entry.path.startsWith('intents/'));
    const intents = entries.filter(entry => entry.path.startsWith('intents/')).sort((a, b) => a.path.localeCompare(b.path));
    const maxIntents = this.options.maxIntents ?? 100;
    const selected = [...state, ...intents.slice(0, maxIntents)];
    const maxBytes = this.options.maxFileBytes ?? 4 * 1024 * 1024;
    const files: Record<string, string> = {};
    for (let i = 0; i < selected.length; i += 8) {
      await Promise.all(selected.slice(i, i + 8).map(async entry => {
        if (entry.size !== undefined && entry.size > maxBytes) throw new GitHubError(413, 'state_file_large', `${entry.path} exceeds the supported size.`);
        const blob = await this.client.request('GET', `${this.base}/git/blobs/${entry.sha}`);
        if (blob.data?.encoding !== 'base64' || typeof blob.data?.content !== 'string') throw new GitHubError(502, 'github_invalid', `GitHub returned an unsupported blob for ${entry.path}.`);
        try { files[entry.path] = decodeBase64Utf8(blob.data.content); }
        catch { throw new GitHubError(422, 'state_file_encoding', `${entry.path} is not UTF-8 text.`); }
      }));
    }
    return { sha, treeSha, files, intentsTruncated: intents.length > maxIntents };
  }

  async commit(base: Pick<StateSnapshot, 'sha' | 'treeSha'>, changes: FileChange[], message: string): Promise<CommitResult> {
    if (!changes.length) return { ok: true, sha: base.sha, changed: false };
    const tree = await this.client.request('POST', `${this.base}/git/trees`, {
      base_tree: base.treeSha,
      tree: changes.map(change => change.content === null
        ? { path: change.path, mode: '100644', type: 'blob', sha: null }
        : { path: change.path, mode: '100644', type: 'blob', content: change.content }),
    });
    const commit = await this.client.request('POST', `${this.base}/git/commits`, { message, tree: tree.data?.sha, parents: [base.sha] });
    const sha = commit.data?.sha;
    if (typeof sha !== 'string') throw new GitHubError(502, 'github_invalid', 'GitHub did not return the new commit.');
    try {
      await this.client.request('PATCH', `${this.base}/git/refs/heads/${this.ref.branch}`, { sha, force: false });
    } catch (error) {
      // 422 "Update is not a fast forward": another writer moved the branch. The orphan commit is harmless.
      if (error instanceof GitHubError && (error.status === 422 || error.status === 409)) return { ok: false, reason: 'conflict' };
      throw error;
    }
    return { ok: true, sha, changed: true };
  }

  async setWorkflowEnabled(enabled: boolean): Promise<void> {
    if (!this.ref.workflowFile) throw new GitHubError(400, 'workflow_unknown', 'No coordinator workflow file is configured.');
    await this.client.request('PUT', `${this.base}/actions/workflows/${this.ref.workflowFile}/${enabled ? 'enable' : 'disable'}`);
  }

  /** Lets a client wake the coordinator after writing an intent (repository_dispatch). */
  async dispatchEvent(eventType: 'agent-empire-intent' | 'agent-empire-start' | 'agent-empire-shutdown'): Promise<void> {
    await this.client.request('POST', `${this.base}/dispatches`, { event_type: eventType });
  }
}

// ---------------------------------------------------------------- in-memory fake (tests, fixtures)

/** A single-branch repository in memory with the same optimistic-concurrency contract as GitHub. */
export class MemoryStateStore implements StateStore, WorkflowControl {
  commits: { sha: string; parent?: string; message: string; files: Record<string, string> }[] = [];
  workflowEnabled = true;
  workflowCalls: boolean[] = [];
  reads = 0;
  /** Test hook: runs once before the next commit is applied, e.g. to simulate a client push. */
  beforeNextCommit?: () => void;
  failWorkflowControl = false;
  private counter = 0;

  constructor(initial: Record<string, string> = {}, private maxIntents = 100) {
    this.commits.push({ sha: this.nextSha(), message: 'initial', files: { ...initial } });
  }
  private nextSha() { return (++this.counter).toString(16).padStart(40, '0'); }
  get head() { return this.commits[this.commits.length - 1]; }
  get files() { return { ...this.head.files }; }

  async read(): Promise<StateSnapshot> {
    this.reads++;
    const paths = Object.keys(this.head.files).filter(isStatePath);
    const intents = paths.filter(path => path.startsWith('intents/')).sort();
    const selected = [...paths.filter(path => !path.startsWith('intents/')), ...intents.slice(0, this.maxIntents)];
    return { sha: this.head.sha, treeSha: this.head.sha, files: Object.fromEntries(selected.map(path => [path, this.head.files[path]])), intentsTruncated: intents.length > this.maxIntents };
  }

  async commit(base: Pick<StateSnapshot, 'sha' | 'treeSha'>, changes: FileChange[], message: string): Promise<CommitResult> {
    const hook = this.beforeNextCommit; this.beforeNextCommit = undefined; hook?.();
    if (!changes.length) return { ok: true, sha: base.sha, changed: false };
    if (base.sha !== this.head.sha) return { ok: false, reason: 'conflict' };
    this.apply(changes, message);
    return { ok: true, sha: this.head.sha, changed: true };
  }

  /** Simulates another writer (a client adding an intent) moving the branch. */
  push(changes: FileChange[], message = 'client write') { this.apply(changes, message); }

  async setWorkflowEnabled(enabled: boolean): Promise<void> {
    this.workflowCalls.push(enabled);
    if (this.failWorkflowControl) throw new GitHubError(403, 'github_http', 'Resource not accessible by integration');
    this.workflowEnabled = enabled;
  }

  private apply(changes: FileChange[], message: string) {
    const files = { ...this.head.files };
    for (const change of changes) { if (change.content === null) delete files[change.path]; else files[change.path] = change.content; }
    this.commits.push({ sha: this.nextSha(), parent: this.head.sha, message, files });
  }
}
