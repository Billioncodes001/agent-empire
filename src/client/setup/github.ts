/**
 * The GitHub REST calls the setup makes, against api.github.com (which allows CORS). The token is sent only
 * there, never as a cookie and never in a URL. `fetchImpl` is injected so tests use a fake GitHub.
 */
import type { RepoRef } from './model';

export const GITHUB_API = 'https://api.github.com';
export const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/;

export class GitHubError extends Error {
  constructor(message: string, readonly status: number, readonly detail?: string) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface GitHubUser {
  login: string;
  name?: string | null;
  /** GitHub plan name (free, pro, …) when the token may see it; used only for the Actions minutes estimate. */
  plan?: string | null;
}
export interface RepoListing extends RepoRef {
  description?: string | null;
  pushedAt?: string | null;
  canPush: boolean;
}
interface RawRepo {
  name: string;
  owner: { login: string };
  private: boolean;
  default_branch?: string;
  description?: string | null;
  pushed_at?: string | null;
  permissions?: { push?: boolean; admin?: boolean };
}

const toListing = (r: RawRepo): RepoListing => ({
  owner: r.owner.login,
  name: r.name,
  private: !!r.private,
  defaultBranch: r.default_branch || 'main',
  description: r.description ?? null,
  pushedAt: r.pushed_at ?? null,
  canPush: !!(r.permissions?.push || r.permissions?.admin),
});

function friendly(status: number, message: string): string {
  if (status === 401) return 'GitHub didn’t accept this sign-in. It may have expired or been revoked; link GitHub again.';
  if (status === 403 && /rate limit/i.test(message)) return 'GitHub’s rate limit was reached. Wait a few minutes and try again.';
  if (status === 403) return 'GitHub refused this action. The token may be missing a permission listed on this screen.';
  if (status === 404) return 'GitHub couldn’t find that, or the token can’t see it.';
  if (status === 422) return `GitHub rejected the request: ${message || 'validation failed'}.`;
  if (status >= 500) return 'GitHub is having trouble. Try again shortly.';
  return `GitHub answered with an error (${status}).`;
}

const seg = (s: string, re: RegExp) => {
  if (!re.test(s)) throw new GitHubError('Invalid repository name.', 0);
  return encodeURIComponent(s);
};

/** UTF-8 text to base64 (the Contents API encoding). */
export function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly base = GITHUB_API,
  ) {
    if (!token || /\s/.test(token)) throw new GitHubError('Enter a GitHub token.', 0);
  }

  async request<T>(method: string, path: string, body?: unknown, allow: number[] = []): Promise<{ status: number; data: T }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        credentials: 'omit',
        cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new GitHubError('Can’t reach GitHub. Check your connection and try again.', 0);
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok && !allow.includes(res.status)) {
      const message = typeof (data as { message?: unknown })?.message === 'string' ? (data as { message: string }).message : '';
      throw new GitHubError(friendly(res.status, message), res.status, message);
    }
    return { status: res.status, data: data as T };
  }

  async user(): Promise<GitHubUser> {
    const { data } = await this.request<{ login?: unknown; name?: unknown; plan?: { name?: unknown } }>('GET', '/user');
    if (typeof data?.login !== 'string' || !GITHUB_OWNER.test(data.login)) throw new GitHubError('GitHub returned an unexpected account.', 200);
    const plan = typeof data.plan?.name === 'string' && /^[a-z_ -]{1,40}$/i.test(data.plan.name) ? data.plan.name.toLowerCase() : null;
    return { login: data.login, name: typeof data.name === 'string' ? data.name : null, plan };
  }

  /** Repositories the account can see, most recently pushed first, 100 per page. */
  async listRepos(page = 1): Promise<{ repos: RepoListing[]; more: boolean }> {
    const q = new URLSearchParams({ per_page: '100', page: String(Math.max(1, Math.floor(page))), sort: 'pushed', affiliation: 'owner,collaborator,organization_member' });
    const { data } = await this.request<RawRepo[]>('GET', `/user/repos?${q}`);
    const repos = Array.isArray(data) ? data.filter((r) => r?.owner?.login && r.name).map(toListing) : [];
    return { repos, more: repos.length === 100 };
  }

  async getRepo(owner: string, name: string): Promise<RepoListing | null> {
    const { status, data } = await this.request<RawRepo>('GET', `/repos/${seg(owner, GITHUB_OWNER)}/${seg(name, GITHUB_REPO)}`, undefined, [404]);
    return status === 404 ? null : toListing(data);
  }

  /** Creates a private repository for the signed-in user. Null when the name is already taken (422). */
  async createPrivateRepo(name: string, description: string): Promise<RepoListing | null> {
    const { status, data } = await this.request<RawRepo>(
      'POST',
      '/user/repos',
      { name: seg(name, GITHUB_REPO), private: true, description, auto_init: true, has_issues: false, has_wiki: false, has_projects: false },
      [422],
    );
    return status === 422 ? null : toListing(data);
  }

  async actionsPublicKey(owner: string, name: string): Promise<{ keyId: string; key: string }> {
    const { data } = await this.request<{ key_id?: unknown; key?: unknown }>('GET', `/repos/${seg(owner, GITHUB_OWNER)}/${seg(name, GITHUB_REPO)}/actions/secrets/public-key`);
    if (typeof data?.key_id !== 'string' || typeof data?.key !== 'string') throw new GitHubError('GitHub returned an unexpected repository key.', 200);
    return { keyId: data.key_id, key: data.key };
  }

  async putSecret(owner: string, name: string, secret: string, encryptedValue: string, keyId: string): Promise<void> {
    if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(secret)) throw new GitHubError('Invalid secret name.', 0);
    await this.request('PUT', `/repos/${seg(owner, GITHUB_OWNER)}/${seg(name, GITHUB_REPO)}/actions/secrets/${secret}`, { encrypted_value: encryptedValue, key_id: keyId });
  }

  /** The blob sha of a file, or null when it does not exist. */
  async fileSha(owner: string, name: string, path: string): Promise<string | null> {
    const { status, data } = await this.request<{ sha?: unknown }>('GET', `/repos/${seg(owner, GITHUB_OWNER)}/${seg(name, GITHUB_REPO)}/contents/${encodePath(path)}`, undefined, [404]);
    return status === 404 ? null : typeof data?.sha === 'string' ? data.sha : null;
  }

  /** Creates or replaces a file on the default branch with one commit. */
  async putFile(owner: string, name: string, path: string, content: string, message: string): Promise<void> {
    const sha = await this.fileSha(owner, name, path);
    await this.request('PUT', `/repos/${seg(owner, GITHUB_OWNER)}/${seg(name, GITHUB_REPO)}/contents/${encodePath(path)}`, {
      message,
      content: utf8Base64(content),
      ...(sha ? { sha } : {}),
    });
  }
}

function encodePath(path: string): string {
  const parts = path.split('/');
  if (!parts.length || parts.some((p) => !p || p === '.' || p === '..' || !/^[A-Za-z0-9._-]+$/.test(p))) throw new GitHubError('Invalid file path.', 0);
  return parts.map(encodeURIComponent).join('/');
}
