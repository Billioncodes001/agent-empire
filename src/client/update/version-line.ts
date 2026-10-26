/**
 * The versions line in Settings › Updates and the game menu: "Game 1.0.0-beta.2 (build 1fb8e12, 25 Oct 2026) · desktop
 * app 1.0.0-beta.2 · Beta channel". DEVICE-BUGS-03: the build (commit and date, tools/release/game-build.mjs) tells a
 * release apart from a newer development build that still carries the same version.
 */
export interface GameBuild { commit: string | null; date: string | null; dirty: boolean }

declare const __AGENT_EMPIRE_GAME_BUILD__: GameBuild | undefined;
/** The build this page was made from (vite define), or null for a build without Git information. */
export function builtGameBuild(): GameBuild | null {
  const b = typeof __AGENT_EMPIRE_GAME_BUILD__ === 'object' && __AGENT_EMPIRE_GAME_BUILD__ ? __AGENT_EMPIRE_GAME_BUILD__ : null;
  return b && typeof b.commit === 'string' && /^[0-9a-f]{7,40}$/.test(b.commit) ? b : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "build 1fb8e12, 25 Oct 2026"; a "+" marks a build from uncommitted changes. */
export function buildLabel(b: GameBuild): string {
  const d = b.date ? new Date(b.date) : null;
  const when = d && !Number.isNaN(d.getTime()) ? `, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : '';
  return `build ${(b.commit ?? '').slice(0, 7)}${b.dirty ? '+' : ''}${when}`;
}

const PLATFORM_LABEL: Record<string, string> = { ios: 'iPhone and iPad app', android: 'Android app', desktop: 'desktop app' };

export interface VersionState {
  game: string | null;
  info: { platform: string; shellVersion: string } | null;
  serverVersion?: string | null;
  channel: string;
}

declare const __AGENT_EMPIRE_GAME_VERSION__: string | undefined;
const compiledVersion = (): string | null => (typeof __AGENT_EMPIRE_GAME_VERSION__ === 'string' ? __AGENT_EMPIRE_GAME_VERSION__ : null);

/**
 * `build` describes this page. It is shown only when the game version reported (`s.game`, which can come from the shell)
 * is the version this page was compiled as; otherwise it would name another bundle's build.
 */
export function versionLine(s: VersionState, build: GameBuild | null = builtGameBuild(), pageVersion: string | null = compiledVersion()): string {
  const ownBuild = !!s.game && !!build?.commit && pageVersion !== null && s.game === pageVersion;
  const parts = [`Game ${s.game ?? 'version unknown'}${ownBuild ? ` (${buildLabel(build!)})` : ''}`];
  if (s.info) parts.push(`${PLATFORM_LABEL[s.info.platform] ?? 'App'} ${s.info.shellVersion}`);
  if (s.serverVersion) parts.push(`Server ${s.serverVersion}`);
  parts.push(`${s.channel === 'beta' ? 'Beta' : 'Stable'} channel`);
  return parts.join(' · ');
}
