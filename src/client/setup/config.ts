/**
 * Build-time configuration for the setup.
 *
 * GitHub OAuth App client id (public; device flow only, no client secret ever ships). Resolution order:
 *   1. VITE_AGENT_EMPIRE_GITHUB_CLIENT_ID at build time (override, e.g. for a fork's own OAuth App),
 *   2. <meta name="agent-empire-github-client-id" content="…"> in index.html (the default for this project).
 * An empty value means "not configured": the setup says so and offers the token fallback.
 */
export const GITHUB_SCOPES = ['repo', 'workflow'];
const CLIENT_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function githubClientId(doc: Pick<Document, 'querySelector'> | null = typeof document === 'undefined' ? null : document): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_AGENT_EMPIRE_GITHUB_CLIENT_ID?.trim();
  const meta = doc?.querySelector<HTMLMetaElement>('meta[name="agent-empire-github-client-id"]')?.content?.trim();
  const id = env || meta || '';
  return CLIENT_ID.test(id) ? id : '';
}

/** Where a fine-grained token is created (web fallback, or when sign-in isn't configured). */
export const GITHUB_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';
/** GitHub's new-repository page, prefilled: a private agent-empire-state (so a token needs no Administration permission). */
export const GITHUB_NEW_STATE_REPO_URL = 'https://github.com/new?name=agent-empire-state&visibility=private&description=Agent+Empire+state';
export const PROVIDER_KEY_URLS = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
} as const;
