/**
 * Signed update-channel fixtures for tests and tools/update-fixture.ts, shaped like tools/release/channel.mjs output.
 * Signs with the DEV release key, whose seed is public (tools/release/sign.mjs DEV_KEY_SEED_TEXT): anything signed
 * here proves nothing outside development builds.
 */
import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import nacl from 'tweetnacl';
import { DEV_RELEASE_PUBLIC_KEY } from '../src/shared/release-key';
import { RELEASE_REPO } from '../src/client/update/channel';

/** Same text as tools/release/sign.mjs DEV_KEY_SEED_TEXT (the release lane's dev key). */
export const DEV_KEY_SEED_TEXT = 'agent-empire/dev-release-key/v1: public test key, never trusted by a release build';
export const DEV_KEYPAIR = nacl.sign.keyPair.fromSeed(createHash('sha256').update(DEV_KEY_SEED_TEXT).digest());
if (Buffer.from(DEV_KEYPAIR.publicKey).toString('base64') !== DEV_RELEASE_PUBLIC_KEY) throw new Error('dev key seed and pinned dev key differ');

/** Another key, for "signed by the wrong key" cases. */
export const OTHER_KEYPAIR = nacl.sign.keyPair.fromSeed(createHash('sha256').update('not the release key').digest());

export const sign = (text: string, secretKey: Uint8Array = DEV_KEYPAIR.secretKey) => Buffer.from(nacl.sign.detached(new TextEncoder().encode(text), secretKey)).toString('base64');
export const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
export const asset = (version: string, file: string) => `https://github.com/${RELEASE_REPO}/releases/download/v${version}/${file}`;

export function channelJson(opts: { channel?: 'stable' | 'beta'; version: string; gameSha?: string; minShell?: string; coordinatorSha?: string; schema?: number; notes?: string; android?: Record<string, unknown> }) {
  const v = opts.version;
  const page = `https://github.com/${RELEASE_REPO}/releases/tag/v${v}`;
  const zip = (name: string) => ({ name, url: asset(v, name), sha256: 'e'.repeat(64) });
  return {
    schema: 1,
    channel: opts.channel ?? 'stable',
    version: v,
    tag: `v${v}`,
    publishedAt: '2026-10-03T12:00:00Z',
    notes: opts.notes ?? `Release ${v}: faster city loading.`,
    releasePage: page,
    game: { url: asset(v, `agent-empire-game-${v}.zip`), sha256: opts.gameSha ?? 'a'.repeat(64), bytes: 1234, minShell: opts.minShell ?? '0.1.0', manifest: asset(v, 'game-manifest.json'), manifestSig: asset(v, 'game-manifest.json.sig') },
    shell: {
      macos: { version: v, url: page, auto: true, downloads: { arm64: { zip: zip(`Agent-Empire-${v}-macos-arm64.zip`), signed: true } }, feed: { arm64: asset(v, 'desktop-update-darwin-arm64.json'), x64: asset(v, 'desktop-update-darwin-x64.json') } },
      windows: { version: v, url: page, auto: false, downloads: { x64: { zip: zip(`Agent-Empire-${v}-windows-x64.zip`), signed: false } } },
      android: { version: v, versionCode: 10000302, name: `Agent-Empire-${v}-android.apk`, url: asset(v, `Agent-Empire-${v}-android.apk`), sha256: 'b'.repeat(64), signed: true, play: 'https://play.google.com/store/apps/details?id=com.agentempire.mobile', ...opts.android },
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

/** One file in a test zip. `mode` sets unix permissions/type (e.g. 0o120777 for a symlink). */
export interface ZipFile { name: string; data?: string | Buffer; mode?: number; deflate?: boolean; encrypted?: boolean }

/** A minimal zip writer (store or deflate) for fixtures, including deliberately hostile entries. */
export function makeZip(files: ZipFile[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data ?? '', 'utf8');
    const deflate = f.deflate ?? raw.length > 64;
    const body = deflate ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const flags = f.encrypted ? 1 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28);
    const mode = f.mode ?? (f.name.endsWith('/') ? 0o040755 : 0o100644);
    central.writeUInt32LE((mode << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A tiny game bundle zip for `version` (index.html reports booting unless `broken`). */
export function gameZip(version: string, opts: { broken?: boolean } = {}) {
  const html = opts.broken
    ? `<!doctype html><title>broken ${version}</title><script>throw new Error('broken bundle')</script>`
    : `<!doctype html><html><head><title>Agent Empire ${version}</title></head><body>game ${version}</body></html>`;
  return makeZip([
    { name: 'index.html', data: html },
    { name: 'game-version.json', data: JSON.stringify({ version }) },
    { name: 'assets/', mode: 0o040755 },
    { name: 'assets/main.js', data: `console.log(${JSON.stringify(version)});`.repeat(10) },
  ]);
}
