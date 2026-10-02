/**
 * What a verified channel file means for this app (docs/team/RELEASE_PLAN.md, "In-app updates"): pure, so the rules
 * are unit-tested.
 *
 *   game     a newer game bundle the shell can install, or one that first needs a newer native app (minShell)
 *   native   a newer native app for this platform, through the platform's own path
 *   server   (server mode) the connected server runs an older version than the channel's: shown, never changed
 *
 * Versions only move forward: nothing older than or equal to what is installed is ever offered.
 */
import type { ChannelFile } from './channel';
import type { NativeInfo, OpenNativeParams } from './bridge';
import { compareSemver, isNewer, isSemver } from './semver';

export type GameOffer =
  | { kind: 'none' }
  | { kind: 'install'; version: string; url: string; sha256: string }
  /** The bundle needs a newer native app first. */
  | { kind: 'needs-shell'; version: string; minShell: string };

export interface NativeOffer {
  version: string;
  params: OpenNativeParams;
  /** How the update happens, for the button label. */
  how: 'auto' | 'download' | 'store' | 'installer';
}

export interface Offer {
  version: string;
  notes: string;
  mandatory: boolean;
  game: GameOffer;
  native: NativeOffer | null;
  server: { running: string; available: string } | null;
  /** True when there is anything to show the player. */
  any: boolean;
}

/** The native update entry for this platform, or null when the channel has nothing newer for it. */
export function nativeOffer(channel: ChannelFile, info: NativeInfo): NativeOffer | null {
  const s = channel.shell;
  if (info.platform === 'desktop') {
    const entry = info.os === 'macos' ? s.macos : info.os === 'windows' ? s.windows : undefined;
    if (!entry || !isNewer(entry.version, info.shellVersion)) return null;
    const feed = info.arch ? entry.feed?.[info.arch] : undefined;
    const auto = entry.auto && !!feed && info.canAutoUpdate;
    return { version: entry.version, params: { version: entry.version, url: entry.url, ...(auto ? { feed } : {}) }, how: auto ? 'auto' : 'download' };
  }
  if (info.platform === 'android') {
    const a = s.android;
    if (!a || !isNewer(a.version, info.shellVersion)) return null;
    if (info.installSource === 'play') return a.play ? { version: a.version, params: { version: a.version, play: a.play }, how: 'store' } : null;
    // A sideloaded app installs the APK itself only with the APK's sha256 from the signed channel.
    if (a.url && a.sha256) return { version: a.version, params: { version: a.version, url: a.url, sha256: a.sha256 }, how: 'installer' };
    return a.play ? { version: a.version, params: { version: a.version, play: a.play }, how: 'store' } : null;
  }
  const i = s.ios;
  if (!i || !isNewer(i.version, info.shellVersion)) return null;
  const preferTestflight = info.installSource !== 'appstore';
  const params: OpenNativeParams = { version: i.version };
  if (preferTestflight && i.testflight) params.testflight = i.testflight;
  else if (i.appStore) params.appStore = i.appStore;
  else if (i.testflight) params.testflight = i.testflight;
  else return null;
  return { version: i.version, params, how: 'store' };
}

export function decide(channel: ChannelFile, ctx: { info: NativeInfo | null; serverVersion?: string | null }): Offer {
  const info = ctx.info;
  let game: GameOffer = { kind: 'none' };
  if (info?.canInstallGame) {
    // Never below the bundle running now, the one built into the app, or one already waiting to start.
    const floor = [info.installedGame, info.builtinGame, info.pendingGame].filter(isSemver).sort(compareSemver).pop() ?? null;
    if (isNewer(channel.version, floor) && channel.version !== info.rolledBack) {
      game = compareSemver(info.shellVersion, channel.game.minShell) < 0
        ? { kind: 'needs-shell', version: channel.version, minShell: channel.game.minShell }
        : { kind: 'install', version: channel.version, url: channel.game.url, sha256: channel.game.sha256 };
    }
  }
  const native = info ? nativeOffer(channel, info) : null;
  const server = ctx.serverVersion && isSemver(ctx.serverVersion) && isNewer(channel.version, ctx.serverVersion) ? { running: ctx.serverVersion, available: channel.version } : null;
  return { version: channel.version, notes: channel.notes, mandatory: channel.mandatory, game, native, server, any: game.kind !== 'none' || !!native || !!server };
}
