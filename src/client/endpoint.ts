/**
 * Where the office host lives. In a browser this is the page's own origin. A bundled app shell can
 * point the client at a remote host with <meta name="agent-empire-host" content="https://city.example.com">
 * (or window.AGENT_EMPIRE_HOST) instead of relying on same-origin paths.
 */
export function hostBase(): string {
  const configured =
    (window as unknown as { AGENT_EMPIRE_HOST?: string }).AGENT_EMPIRE_HOST ??
    document.querySelector<HTMLMetaElement>('meta[name="agent-empire-host"]')?.content;
  return configured?.trim() || location.origin;
}

/** An absolute URL on the office host for an API path or page such as '/api/logout' or '/login'. */
export function hostUrl(path: string): string {
  return new URL(path, hostBase()).href;
}
