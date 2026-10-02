/**
 * Page side of the `update.*` bridge calls (REL-04). Every shell implements the same contract and validates the same
 * parameters again natively (desktop/bridge-policy.cjs, Android BridgePolicy/UpdatePolicy, iOS BridgeProtocol/UpdatePolicy):
 *
 *   update.fetch({url, etag?})                → {status, body, etag}   GET a release asset / the releases listing
 *                                                                       (github.com → objects/release-assets redirects
 *                                                                       followed natively: they send no CORS headers)
 *   update.installGame({url, sha256, version}) → {version}             download, sha256, unzip into app data, pending
 *   update.activate()                          → true, then the shell restarts the game into the pending bundle
 *   update.bootOk()                            → true                  this bundle booted; the shell marks it known-good
 *   update.nativeInfo()                        → NativeInfo
 *   update.openNative({...})                   → {action}              the platform's native update path
 */
import { BridgeError, NativeBridge, TIMEOUTS, native, type AppPlatform, type Native } from '../native';
import { isAppleUrl, isPlayUrl, releaseAsset, releasePage, RELEASES_API, type DesktopArch } from './channel';
import { isSemver } from './semver';

export type DesktopOs = 'macos' | 'windows' | 'linux';
export interface NativeInfo {
  platform: AppPlatform;
  /** The native app's own version. */
  shellVersion: string;
  /** desktop only */
  os?: DesktopOs;
  /** desktop only: picks the Squirrel.Mac feed */
  arch?: DesktopArch;
  /** The game version running now (an installed bundle, or the one built into the app). */
  installedGame: string | null;
  /** The game version built into the app (the final fallback). */
  builtinGame: string | null;
  /** Installed and waiting for activate() or the next start. */
  pendingGame: string | null;
  /** Shell can install game bundles (update.installGame). */
  canInstallGame: boolean;
  /** The native app can update itself in place (signed desktop app with a feed). */
  canAutoUpdate: boolean;
  /** Android: 'play' or 'sideload'; iOS: 'testflight' or 'appstore' or 'development'. */
  installSource?: string;
  /** One-shot: the version the shell rolled back from at this start (it never reported booting). */
  rolledBack?: string;
}

export interface FetchResult {
  status: number;
  body: string;
  etag: string | null;
}

export type NativeAction = 'auto-update' | 'opened' | 'installer' | 'permission' | 'store';

export interface OpenNativeParams {
  version: string;
  url?: string;
  feed?: string;
  sha256?: string;
  play?: string;
  testflight?: string;
  appStore?: string;
}

export interface UpdateBridge {
  readonly platform: AppPlatform;
  fetch(url: string, etag?: string): Promise<FetchResult>;
  installGame(p: { url: string; sha256: string; version: string }): Promise<{ version: string }>;
  activate(): Promise<void>;
  bootOk(): Promise<void>;
  nativeInfo(): Promise<NativeInfo>;
  openNative(p: OpenNativeParams): Promise<{ action: NativeAction }>;
}

const SHA = /^[0-9a-f]{64}$/;
const str = (v: unknown, max = 64) => (typeof v === 'string' && v.length <= max ? v : null);

/** Validates a nativeInfo answer; anything malformed is refused rather than guessed. */
export function parseNativeInfo(raw: unknown, platform: AppPlatform): NativeInfo {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (r.platform !== platform || !isSemver(r.shellVersion)) throw new BridgeError('The app reported an unexpected version.', 'invalid');
  const ver = (v: unknown) => (isSemver(v) ? v : null);
  const info: NativeInfo = {
    platform,
    shellVersion: r.shellVersion,
    installedGame: ver(r.installedGame),
    builtinGame: ver(r.builtinGame),
    pendingGame: ver(r.pendingGame),
    canInstallGame: r.canInstallGame === true,
    canAutoUpdate: r.canAutoUpdate === true,
  };
  if (platform === 'desktop' && (r.os === 'macos' || r.os === 'windows' || r.os === 'linux')) info.os = r.os;
  if (platform === 'desktop' && (r.arch === 'arm64' || r.arch === 'x64')) info.arch = r.arch;
  const source = str(r.installSource, 32);
  if (source && /^[a-z-]+$/.test(source)) info.installSource = source;
  if (isSemver(r.rolledBack)) info.rolledBack = r.rolledBack;
  return info;
}

/** URLs the page may ask a shell to fetch: release assets of the pinned repository, or the releases listing. */
export const isFetchableUrl = (url: string) => url === RELEASES_API || releaseAsset(url) !== null;

export function updateBridge(n: Native = native()): UpdateBridge | null {
  if (!(n instanceof NativeBridge) || !n.available || !n.platform) return null;
  const platform = n.platform;
  return {
    platform,
    async fetch(url, etag) {
      if (!isFetchableUrl(url)) throw new BridgeError('That address is not an Agent Empire release.', 'invalid');
      const r = await n.call<Record<string, unknown>>('update.fetch', etag ? { url, etag: etag.slice(0, 200) } : { url }, 60_000);
      if (!r || !Number.isInteger(r.status) || typeof r.body !== 'string') throw new BridgeError('The app returned an unexpected download.', 'invalid');
      return { status: r.status as number, body: r.body, etag: typeof r.etag === 'string' ? r.etag : null };
    },
    async installGame(p) {
      if (!releaseAsset(p.url) || !SHA.test(p.sha256) || !isSemver(p.version)) throw new BridgeError('That update is not valid.', 'invalid');
      const r = await n.call<Record<string, unknown>>('update.installGame', { url: p.url, sha256: p.sha256, version: p.version }, TIMEOUTS.update);
      if (!r || r.version !== p.version) throw new BridgeError('The app installed something unexpected.', 'invalid');
      return { version: p.version };
    },
    async activate() {
      await n.call('update.activate', {});
    },
    async bootOk() {
      await n.call('update.bootOk', {});
    },
    async nativeInfo() {
      return parseNativeInfo(await n.call('update.nativeInfo', {}), platform);
    },
    async openNative(p) {
      if (!isSemver(p.version)) throw new BridgeError('That update is not valid.', 'invalid');
      const params: Record<string, string> = { version: p.version };
      if (p.url && (releaseAsset(p.url) || releasePage(p.url))) params.url = p.url;
      if (p.feed && releaseAsset(p.feed)) params.feed = p.feed;
      if (p.sha256 && SHA.test(p.sha256)) params.sha256 = p.sha256;
      if (p.play && isPlayUrl(p.play)) params.play = p.play;
      if (p.testflight && isAppleUrl(p.testflight)) params.testflight = p.testflight;
      if (p.appStore && isAppleUrl(p.appStore)) params.appStore = p.appStore;
      const r = await n.call<Record<string, unknown>>('update.openNative', params, TIMEOUTS.update);
      const action = r?.action;
      if (!['auto-update', 'opened', 'installer', 'permission', 'store'].includes(action as string)) throw new BridgeError('The app returned an unexpected answer.', 'invalid');
      return { action: action as NativeAction };
    },
  };
}
