/**
 * An in-memory api.github.com for tests and the UI checks: the subset the coordinator, the installer, the setup and
 * the app's cloud adapter use. Nothing here touches the network. Shared by tests/*.test.ts and tools/*-ui-check.ts.
 */
import { encodeBase64Utf8, decodeBase64Utf8 } from '../src/cloud/store';

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(data === undefined || status === 204 || status === 304 ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

export interface FakeRepo {
  private: boolean; owner: string; default_branch: string; ref: string;
  commits: Map<string, { tree: string; parents: string[]; message: string }>;
  trees: Map<string, Map<string, string>>; blobs: Map<string, string>;
  secrets: Map<string, { encrypted_value: string; key_id: string }>;
  workflow: 'active' | 'disabled_manually'; dispatches: string[];
  /** Ref reads that still answer 409 "empty" after an auto_init create (GitHub creates the first commit asynchronously). */
  pendingInit: number;
}
export interface FakeRequest { method: string; path: string; auth?: string; body?: any; ifNoneMatch?: string; status?: number }

export class FakeGitHub {
  repos = new Map<string, FakeRepo>();
  requests: FakeRequest[] = [];
  private n = 0;
  login = 'founder';
  /** The repository Actions public key (base64). Tests that open sealed secrets set a real X25519 key. */
  publicKey = 'cHVibGljLWtleS1iYXNlNjQ=';
  plan: { name: string } | undefined = { name: 'free' };
  /** HTTP status for POST /user/repos, e.g. 403 for a fine-grained token without Administration permission. */
  createStatus = 201;
  /** Ref reads answering 409 after a create with auto_init. */
  autoInitDelay = 0;
  /** Test hook: run before the next ref update is evaluated (simulate a concurrent pusher). */
  beforeRefUpdate?: () => void;
  /** Raw (possibly non-UTF-8 or oversized) blobs by sha, for client-written files. */
  raw = new Map<string, { base64: string; size: number }>();
  blobReads: string[] = [];
  /** Test hook: HTTP status to return for a blob (e.g. 403 or 429 rate limiting). */
  blobStatus = new Map<string, number>();
  /** Test hook: fail matching requests with a status, `times` times (e.g. a 502 in the middle of the installer). */
  failures: { method: string; path: RegExp; status: number; times: number; message?: string }[] = [];
  sha() { return (++this.n).toString(16).padStart(40, 'f'); }

  addRaw(full: string, path: string, base64: string, size: number) {
    const repo = this.repos.get(full)!;
    const tree = new Map(repo.trees.get(repo.commits.get(repo.ref)!.tree)!);
    const b = this.sha(); repo.blobs.set(b, ''); this.raw.set(b, { base64, size }); tree.set(path, b);
    const t = this.sha(); repo.trees.set(t, tree); const c = this.sha(); repo.commits.set(c, { tree: t, parents: [repo.ref], message: 'raw client write' }); repo.ref = c;
    return b;
  }
  /** A repository; `files: null` makes an empty one (no commits, as created on github.com without a README). */
  create(full: string, isPrivate = true, files: Record<string, string> | null = { 'README.md': '# state\n' }) {
    const repo: FakeRepo = { private: isPrivate, owner: full.split('/')[0], default_branch: 'main', ref: '', commits: new Map(), trees: new Map(), blobs: new Map(), secrets: new Map(), workflow: 'active', dispatches: [], pendingInit: 0 };
    this.repos.set(full, repo);
    if (files) this.initCommit(repo, files);
    return repo;
  }
  private initCommit(repo: FakeRepo, files: Record<string, string>) {
    const tree = new Map<string, string>();
    for (const [path, content] of Object.entries(files)) { const b = this.sha(); repo.blobs.set(b, content); tree.set(path, b); }
    const treeSha = this.sha(); repo.trees.set(treeSha, tree);
    const commit = this.sha(); repo.commits.set(commit, { tree: treeSha, parents: [], message: 'Initial commit' }); repo.ref = commit;
  }
  files(full: string) {
    const repo = this.repos.get(full)!; if (!repo.ref) return {};
    const tree = repo.trees.get(repo.commits.get(repo.ref)!.tree)!;
    return Object.fromEntries([...tree].map(([path, blob]) => [path, repo.blobs.get(blob)!]));
  }
  commitOnBranch(full: string, changes: Record<string, string | null>, message = 'concurrent write') {
    const repo = this.repos.get(full)!;
    const tree = new Map(repo.trees.get(repo.commits.get(repo.ref)!.tree)!);
    for (const [path, content] of Object.entries(changes)) { if (content === null) tree.delete(path); else { const b = this.sha(); repo.blobs.set(b, content); tree.set(path, b); } }
    const t = this.sha(); repo.trees.set(t, tree); const c = this.sha(); repo.commits.set(c, { tree: t, parents: [repo.ref], message }); repo.ref = c;
    return c;
  }
  /** Write calls (anything but GET/HEAD/OPTIONS) seen so far, as "METHOD /path". */
  get writes() { return this.requests.filter(r => !['GET', 'HEAD', 'OPTIONS'].includes(r.method)).map(r => `${r.method} ${r.path}`); }

  /** A fetch implementation for code under test. Only api.github.com is answered. */
  fetch: typeof fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (url.host !== 'api.github.com') throw new Error(`unexpected host ${url.host}`);
    return this.handle(url, init);
  }) as typeof fetch;

  handle = async (url: URL, init: RequestInit): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const headers = new Headers(init.headers as HeadersInit | undefined);
    const auth = headers.get('authorization') ?? undefined;
    const record: FakeRequest = { method, path: url.pathname, auth, body, ifNoneMatch: headers.get('if-none-match') ?? undefined };
    this.requests.push(record);
    const response = await this.route(url, method, body, record);
    record.status = response.status;
    return response;
  };

  private async route(url: URL, method: string, body: any, req: FakeRequest): Promise<Response> {
    const p = url.pathname;
    const failure = this.failures.find(f => f.times > 0 && f.method === method && f.path.test(p));
    if (failure) { failure.times--; return json({ message: failure.message ?? 'Server Error (fixture)' }, failure.status); }
    if (!req.auth) return json({ message: 'Requires authentication' }, 401);
    if (p === '/user' && method === 'GET') return json({ login: this.login, name: 'Fixture Founder', ...(this.plan ? { plan: this.plan } : {}) });
    if (p === '/user/repos' && method === 'POST') {
      if (this.createStatus !== 201) return json({ message: 'Resource not accessible by personal access token' }, this.createStatus);
      const full = `${this.login}/${body.name}`;
      if (this.repos.has(full)) return json({ message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] }, 422);
      const repo = this.create(full, body.private === true, body.auto_init ? { 'README.md': `# ${body.name}\n` } : null);
      repo.pendingInit = body.auto_init ? this.autoInitDelay : 0;
      return json(this.repoJson(full, repo), 201);
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(p);
    if (!m) return json({ message: 'Not Found' }, 404);
    const full = `${m[1]}/${m[2]}`; const rest = m[3] ?? ''; const repo = this.repos.get(full);
    if (!repo) return json({ message: 'Not Found' }, 404);
    if (rest === '' && method === 'GET') return json(this.repoJson(full, repo));
    let r: RegExpExecArray | null;
    if ((r = /^\/git\/ref\/heads\/(.+)$/.exec(rest)) && method === 'GET') {
      if (r[1] !== repo.default_branch) return json({ message: 'Not Found' }, 404);
      if (!repo.ref || repo.pendingInit > 0) { if (repo.pendingInit > 0) repo.pendingInit--; return json({ message: 'Git Repository is empty.' }, 409); }
      const etag = `W/"ref-${repo.ref}"`;
      if (req.ifNoneMatch === etag) return json(undefined, 304, { etag });
      return json({ ref: `refs/heads/${r[1]}`, object: { sha: repo.ref, type: 'commit' } }, 200, { etag });
    }
    if ((r = /^\/git\/commits\/([a-f0-9]+)$/.exec(rest)) && method === 'GET') { const c = repo.commits.get(r[1]); return c ? json({ sha: r[1], tree: { sha: c.tree }, parents: c.parents.map(sha => ({ sha })), message: c.message }) : json({ message: 'Not Found' }, 404); }
    if ((r = /^\/git\/trees\/([a-f0-9]+)$/.exec(rest)) && method === 'GET') { const t = repo.trees.get(r[1]); if (!t) return json({ message: 'Not Found' }, 404); return json({ sha: r[1], truncated: false, tree: [...t].map(([path, sha]) => ({ path, mode: '100644', type: 'blob', sha, size: this.raw.get(sha)?.size ?? new TextEncoder().encode(repo.blobs.get(sha)!).length })) }); }
    if ((r = /^\/git\/blobs\/([a-f0-9]+)$/.exec(rest)) && this.blobStatus.has(r[1])) return json({ message: 'API rate limit exceeded' }, this.blobStatus.get(r[1]));
    if ((r = /^\/git\/blobs\/([a-f0-9]+)$/.exec(rest)) && this.raw.has(r[1])) { this.blobReads.push(r[1]); return json({ sha: r[1], encoding: 'base64', content: this.raw.get(r[1])!.base64 }); }
    if ((r = /^\/git\/blobs\/([a-f0-9]+)$/.exec(rest))) { this.blobReads.push(r[1]); const text = repo.blobs.get(r[1]); return text === undefined ? json({ message: 'Not Found' }, 404) : json({ sha: r[1], encoding: 'base64', content: encodeBase64Utf8(text).replace(/(.{60})/g, '$1\n') }); }
    if (rest === '/git/trees' && method === 'POST') {
      const baseTree = repo.trees.get(body.base_tree); if (!baseTree) return json({ message: 'Invalid tree' }, 422);
      const tree = new Map(baseTree);
      for (const entry of body.tree) { if (entry.sha === null) tree.delete(entry.path); else { const b = this.sha(); repo.blobs.set(b, entry.content); tree.set(entry.path, b); } }
      const t = this.sha(); repo.trees.set(t, tree); return json({ sha: t }, 201);
    }
    if (rest === '/git/commits' && method === 'POST') { const c = this.sha(); repo.commits.set(c, { tree: body.tree, parents: body.parents, message: body.message }); return json({ sha: c }, 201); }
    if ((r = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && method === 'PATCH') {
      const hook = this.beforeRefUpdate; this.beforeRefUpdate = undefined; hook?.();
      const commit = repo.commits.get(body.sha)!;
      if (!body.force && !commit.parents.includes(repo.ref)) return json({ message: 'Update is not a fast forward' }, 422);
      repo.ref = body.sha; return json({ ref: `refs/heads/${r[1]}`, object: { sha: body.sha } });
    }
    if ((r = /^\/contents\/(.+)$/.exec(rest))) {
      const path = decodeURIComponent(r[1]);
      const tree = repo.ref ? repo.trees.get(repo.commits.get(repo.ref)!.tree)! : new Map<string, string>();
      const blob = tree.get(path);
      if (method === 'GET') return blob ? json({ type: 'file', path, sha: blob, encoding: 'base64', content: encodeBase64Utf8(repo.blobs.get(blob)!) }) : json({ message: 'Not Found' }, 404);
      if (method === 'PUT') {
        if (blob && body.sha !== blob) return json({ message: body.sha ? `${path} does not match ${body.sha}` : 'Invalid request.\n\n"sha" wasn\'t supplied.' }, body.sha ? 409 : 422);
        const content = decodeBase64Utf8(body.content);
        if (!repo.ref) { this.initCommit(repo, { [path]: content }); return json({ content: { path, sha: [...repo.trees.get(repo.commits.get(repo.ref)!.tree)!.values()][0] }, commit: { sha: repo.ref } }, 201); }
        const c = this.commitOnBranch(full, { [path]: content }, body.message);
        return json({ content: { path, sha: repo.trees.get(repo.commits.get(c)!.tree)!.get(path) }, commit: { sha: c } }, blob ? 200 : 201);
      }
    }
    if (rest === '/actions/secrets/public-key') return json({ key_id: 'key-1', key: this.publicKey });
    if ((r = /^\/actions\/secrets\/([A-Z_]+)$/.exec(rest)) && method === 'PUT') { const had = repo.secrets.has(r[1]); repo.secrets.set(r[1], body); return json(undefined, had ? 204 : 201); }
    if ((r = /^\/actions\/workflows\/agent-empire\.yml\/(enable|disable)$/.exec(rest)) && method === 'PUT') { repo.workflow = r[1] === 'enable' ? 'active' : 'disabled_manually'; return json(undefined, 204); }
    if (rest === '/actions/workflows/agent-empire.yml' && method === 'GET') return json({ id: 1, path: '.github/workflows/agent-empire.yml', state: repo.workflow });
    if (rest === '/dispatches' && method === 'POST') { repo.dispatches.push(body.event_type); return json(undefined, 204); }
    return json({ message: 'Not Found' }, 404);
  }

  private repoJson(full: string, repo: FakeRepo) {
    return { full_name: full, name: full.split('/')[1], owner: { login: repo.owner }, private: repo.private, default_branch: repo.default_branch, permissions: { admin: true, push: true, pull: true } };
  }
}
