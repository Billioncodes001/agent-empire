/**
 * The update channel file (docs/team/RELEASE_PLAN.md, "Update channel contract"): `channel-<stable|beta>.json`,
 * signed with Ed25519 (`channel-<channel>.json.sig`). Parsed strictly: anything unexpected makes the whole file
 * untrusted. Every download URL must be a release asset of the pinned repository, and the game zip must come from
 * the release tagged with the channel's own version.
 *
 * Extensions this lane needs from the release pipeline (optional fields; see docs/team/reports/in-app-updates.md):
 *   shell.android.sha256   sha256 of the APK, required before a sideloaded app installs it
 *   shell.macos.feed       the Squirrel.Mac feed URL for Electron's autoUpdater (also windows.feed)
 */
import { isSemver } from './semver';

/** The GitHub repository releases come from (`git remote origin`). Shells pin the same value. */
export const RELEASE_REPO = 'Billioncodes001/agent-empire';
export const CHANNELS = ['stable', 'beta'] as const;
export type Channel = (typeof CHANNELS)[number];
export const isChannel = (v: unknown): v is Channel => CHANNELS.includes(v as Channel);

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_NOTES = 4000;

export interface GameEntry {
  url: string;
  sha256: string;
  minShell: string;
}
export interface DesktopShell {
  version: string;
  url: string;
  auto: boolean;
  feed?: string;
}
export interface AndroidShell {
  version: string;
  versionCode: number;
  url?: string;
  sha256?: string;
  play?: string;
}
export interface IosShell {
  version: string;
  testflight?: string;
  appStore?: string;
}
export interface CoordinatorEntry {
  url: string;
  sha256: string;
  schema: number;
}
export interface ChannelFile {
  schema: 1;
  channel: Channel;
  version: string;
  publishedAt: string;
  notes: string;
  game: GameEntry;
  shell: { macos?: DesktopShell; windows?: DesktopShell; android?: AndroidShell; ios?: IosShell };
  coordinator?: CoordinatorEntry;
  mandatory: boolean;
}

export class ChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelError';
  }
}

/** Hosts GitHub serves release assets from after the github.com redirect. */
export const ASSET_REDIRECT_HOSTS = ['objects.githubusercontent.com', 'release-assets.githubusercontent.com'] as const;

const [OWNER, REPO] = RELEASE_REPO.split('/');

/**
 * A release asset of the pinned repository: https://github.com/<owner>/<repo>/releases/download/<tag>/<file>
 * (or .../releases/latest/download/<file>). Returns {tag, file} or null. `tag` is null for "latest".
 */
export function releaseAsset(url: unknown): { tag: string | null; file: string } | null {
  if (typeof url !== 'string' || url.length > 512) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.port || u.username || u.password || u.search || u.hash) return null;
  const parts = u.pathname.split('/');
  // ['', owner, repo, 'releases', 'download', tag, file] or ['', owner, repo, 'releases', 'latest', 'download', file]
  if (parts[1]?.toLowerCase() !== OWNER.toLowerCase() || parts[2]?.toLowerCase() !== REPO.toLowerCase() || parts[3] !== 'releases') return null;
  const ok = (s: string | undefined) => !!s && /^[A-Za-z0-9._+-]{1,128}$/.test(s) && s !== '.' && s !== '..';
  if (parts.length === 7 && parts[4] === 'download' && ok(parts[5]) && ok(parts[6])) return { tag: parts[5], file: parts[6] };
  if (parts.length === 7 && parts[4] === 'latest' && parts[5] === 'download' && ok(parts[6])) return { tag: null, file: parts[6] };
  return null;
}

const httpsOn = (hosts: string[]) => (url: unknown): url is string => {
  if (typeof url !== 'string' || url.length > 512) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && hosts.includes(u.hostname) && !u.port && !u.username && !u.password;
  } catch {
    return false;
  }
};
export const isPlayUrl = httpsOn(['play.google.com']);
export const isAppleUrl = httpsOn(['apps.apple.com', 'testflight.apple.com', 'itunes.apple.com']);

/** Where the channel files are. Stable: the newest full release. Beta: a given pre-release tag. */
export function channelUrls(channel: Channel, tag?: string): { json: string; sig: string } {
  const base = tag ? `https://github.com/${RELEASE_REPO}/releases/download/${encodeURIComponent(tag)}` : `https://github.com/${RELEASE_REPO}/releases/latest/download`;
  const json = `${base}/channel-${channel}.json`;
  return { json, sig: `${json}.sig` };
}

/** The API listing used to find the newest pre-release (CORS-enabled; conditional requests are not rate limited). */
export const RELEASES_API = `https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=20`;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
function only(where: string, v: unknown, required: string[], optional: string[] = []): Rec {
  if (!isRec(v)) throw new ChannelError(`${where} must be an object`);
  for (const k of required) if (!(k in v)) throw new ChannelError(`${where}.${k} is missing`);
  for (const k of Object.keys(v)) if (!required.includes(k) && !optional.includes(k)) throw new ChannelError(`${where}.${k} is not expected`);
  return v;
}
const version = (where: string, v: unknown) => {
  if (!isSemver(v)) throw new ChannelError(`${where} is not a version`);
  return v;
};
const sha = (where: string, v: unknown) => {
  if (typeof v !== 'string' || !SHA256.test(v)) throw new ChannelError(`${where} is not a sha256`);
  return v;
};
const asset = (where: string, v: unknown, tag?: string) => {
  const a = releaseAsset(v);
  if (!a || a.tag === null) throw new ChannelError(`${where} is not a release asset of ${RELEASE_REPO}`);
  if (tag && a.tag !== tag) throw new ChannelError(`${where} is not from the ${tag} release`);
  return v as string;
};

function desktop(where: string, v: unknown): DesktopShell {
  const r = only(where, v, ['version', 'url'], ['auto', 'feed']);
  const out: DesktopShell = { version: version(`${where}.version`, r.version), url: asset(`${where}.url`, r.url), auto: r.auto === true };
  if (r.auto !== undefined && typeof r.auto !== 'boolean') throw new ChannelError(`${where}.auto must be true or false`);
  if (r.feed !== undefined) out.feed = asset(`${where}.feed`, r.feed);
  return out;
}

/**
 * Parses a channel file's text. `expected` is the channel that was asked for: a stable app never accepts a file that
 * says beta (or the reverse), so a signed file can't be replayed onto the other channel.
 */
export function parseChannel(text: string, expected: Channel): ChannelFile {
  if (typeof text !== 'string' || text.length > 64 * 1024) throw new ChannelError('The channel file is too large');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ChannelError('The channel file is not JSON');
  }
  const r = only('channel', raw, ['schema', 'channel', 'version', 'publishedAt', 'notes', 'game', 'shell', 'mandatory'], ['coordinator']);
  if (r.schema !== 1) throw new ChannelError('Unsupported channel schema');
  if (r.channel !== expected) throw new ChannelError(`The file is for the ${String(r.channel)} channel, not ${expected}`);
  const v = version('channel.version', r.version);
  if (typeof r.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(r.publishedAt) || Number.isNaN(Date.parse(r.publishedAt))) throw new ChannelError('channel.publishedAt is not a date');
  if (typeof r.notes !== 'string' || r.notes.length > MAX_NOTES) throw new ChannelError('channel.notes must be text');
  if (typeof r.mandatory !== 'boolean') throw new ChannelError('channel.mandatory must be true or false');
  const tag = `v${v}`;
  const g = only('game', r.game, ['url', 'sha256', 'minShell']);
  const game: GameEntry = { url: asset('game.url', g.url, tag), sha256: sha('game.sha256', g.sha256), minShell: version('game.minShell', g.minShell) };
  const s = only('shell', r.shell, [], ['macos', 'windows', 'android', 'ios']);
  const shell: ChannelFile['shell'] = {};
  if (s.macos !== undefined) shell.macos = desktop('shell.macos', s.macos);
  if (s.windows !== undefined) shell.windows = desktop('shell.windows', s.windows);
  if (s.android !== undefined) {
    const a = only('shell.android', s.android, ['version', 'versionCode'], ['url', 'sha256', 'play']);
    if (!Number.isSafeInteger(a.versionCode) || (a.versionCode as number) < 1 || (a.versionCode as number) > 2_100_000_000) throw new ChannelError('shell.android.versionCode is invalid');
    const android: AndroidShell = { version: version('shell.android.version', a.version), versionCode: a.versionCode as number };
    if (a.url !== undefined) android.url = asset('shell.android.url', a.url);
    if (a.sha256 !== undefined) android.sha256 = sha('shell.android.sha256', a.sha256);
    if (a.play !== undefined) {
      if (!isPlayUrl(a.play)) throw new ChannelError('shell.android.play is not a Play link');
      android.play = a.play;
    }
    shell.android = android;
  }
  if (s.ios !== undefined) {
    const i = only('shell.ios', s.ios, ['version'], ['testflight', 'appStore']);
    const ios: IosShell = { version: version('shell.ios.version', i.version) };
    for (const k of ['testflight', 'appStore'] as const)
      if (i[k] !== undefined) {
        if (!isAppleUrl(i[k])) throw new ChannelError(`shell.ios.${k} is not an Apple link`);
        ios[k] = i[k] as string;
      }
    shell.ios = ios;
  }
  const out: ChannelFile = { schema: 1, channel: expected, version: v, publishedAt: r.publishedAt, notes: r.notes, game, shell, mandatory: r.mandatory };
  if (r.coordinator !== undefined) {
    const c = only('coordinator', r.coordinator, ['url', 'sha256', 'schema']);
    if (!Number.isSafeInteger(c.schema) || (c.schema as number) < 1) throw new ChannelError('coordinator.schema is invalid');
    out.coordinator = { url: asset('coordinator.url', c.url, tag), sha256: sha('coordinator.sha256', c.sha256), schema: c.schema as number };
  }
  return out;
}

/** Picks the newest pre-release that carries the beta channel files from an api.github.com releases listing. */
export function newestPrereleaseTag(listing: unknown, compare: (a: string, b: string) => number): string | null {
  if (!Array.isArray(listing)) return null;
  let best: string | null = null;
  for (const rel of listing) {
    if (!isRec(rel) || rel.draft === true || rel.prerelease !== true || typeof rel.tag_name !== 'string') continue;
    const tag = rel.tag_name;
    if (!/^v/.test(tag) || !isSemver(tag.slice(1))) continue;
    const names = Array.isArray(rel.assets) ? rel.assets.map((a) => (isRec(a) ? a.name : null)) : [];
    if (!names.includes('channel-beta.json') || !names.includes('channel-beta.json.sig')) continue;
    if (!best || compare(tag.slice(1), best.slice(1)) > 0) best = tag;
  }
  return best;
}
