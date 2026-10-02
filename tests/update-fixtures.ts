/**
 * Signed update-channel fixtures for tests and tools/update-fixture.ts. Signs with the DEV release key, whose seed is
 * public (src/shared/release-key.ts): anything signed here proves nothing outside development builds.
 */
import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import { DEV_RELEASE_KEY_SEED_TEXT, DEV_RELEASE_PUBLIC_KEY } from '../src/shared/release-key';
import { RELEASE_REPO } from '../src/client/update/channel';

export const DEV_KEYPAIR = nacl.sign.keyPair.fromSeed(createHash('sha256').update(DEV_RELEASE_KEY_SEED_TEXT).digest());
if (Buffer.from(DEV_KEYPAIR.publicKey).toString('base64') !== DEV_RELEASE_PUBLIC_KEY) throw new Error('dev key seed and pinned dev key differ');

/** Another key, for "signed by the wrong key" cases. */
export const OTHER_KEYPAIR = nacl.sign.keyPair.fromSeed(createHash('sha256').update('not the release key').digest());

export const sign = (text: string, secretKey: Uint8Array = DEV_KEYPAIR.secretKey) => Buffer.from(nacl.sign.detached(new TextEncoder().encode(text), secretKey)).toString('base64');
export const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
export const asset = (version: string, file: string) => `https://github.com/${RELEASE_REPO}/releases/download/v${version}/${file}`;

export function channelJson(opts: { channel?: 'stable' | 'beta'; version: string; gameSha?: string; minShell?: string; coordinatorSha?: string; schema?: number; notes?: string; android?: Record<string, unknown> }) {
  const v = opts.version;
  return {
    schema: 1,
    channel: opts.channel ?? 'stable',
    version: v,
    publishedAt: '2026-10-03T12:00:00Z',
    notes: opts.notes ?? `Release ${v}: faster city loading.`,
    game: { url: asset(v, `agent-empire-game-${v}.zip`), sha256: opts.gameSha ?? 'a'.repeat(64), minShell: opts.minShell ?? '0.1.0' },
    shell: {
      macos: { version: v, url: asset(v, `Agent-Empire-${v}-mac-arm64.zip`), auto: true },
      windows: { version: v, url: asset(v, `Agent-Empire-${v}-win-x64.zip`), auto: true },
      android: { version: v, versionCode: 10000002, url: asset(v, `Agent-Empire-${v}.apk`), sha256: 'b'.repeat(64), play: 'https://play.google.com/store/apps/details?id=com.agentempire.mobile', ...opts.android },
      ios: { version: v, testflight: 'https://testflight.apple.com/join/AbCdEf12', appStore: 'https://apps.apple.com/app/id0000000000' },
    },
    ...(opts.coordinatorSha ? { coordinator: { url: asset(v, 'agent-empire-coordinator.mjs'), sha256: opts.coordinatorSha, schema: opts.schema ?? 1 } } : {}),
    mandatory: false,
  };
}

/** {text, sig} for a channel file. */
export function signedChannel(opts: Parameters<typeof channelJson>[0], secretKey?: Uint8Array) {
  const text = `${JSON.stringify(channelJson(opts), null, 2)}\n`;
  return { text, sig: sign(text, secretKey) };
}
