/**
 * Game bundle store for in-app updates (docs/team/RELEASE_PLAN.md, REL-04). Pure Node (no Electron), so
 * tests/desktop-updates.test.ts covers every rule; main.cjs wires it to the window and the bridge.
 *
 * Layout under <userData>/game-bundles:
 *   state.json          {active, knownGood, pending, trial, bad[]}  (written atomically: temp file + rename)
 *   <version>/          an unpacked game bundle (index.html, game-version.json, assets…)
 *
 * Lifecycle:
 *   install   download (github.com release asset; redirects only to GitHub's asset hosts), sha256 against the signed
 *             value, unzip into a temp dir with zip-slip protection, check index.html and game-version.json, rename
 *             into place, mark pending. Only a version newer than everything installed or built in (forward only),
 *             never one that already failed to boot.
 *   activate  pending becomes a trial and the window reloads into it (also at the next launch).
 *   bootOk    the page booted: the trial becomes known-good.
 *   rollback  no bootOk within 20 s of the trial starting (or a launch finds an unfinished trial): back to the last
 *             known-good bundle, or the built-in one, which is always the final fallback.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { compareSemver, isSemver, isSha256, releaseAsset, isUpdateFetchUrl, isAssetRedirect } = require('./bridge-policy.cjs');

/**
 * The pinned release key (src/shared/release-key.ts; listed in tools/release/config.json pinnedKeyFiles, so the release
 * gate checks this copy). A release build trusts it alone.
 *
 * Development trust (REL-07) is a build-time choice, never a runtime switch: `node tools/prepare-desktop.mjs
 * --dev-updates` writes dev-trust.json next to this file with the public development key (tools/release/dev-release-public-key.txt), and every other prepare (including every release workflow run) deletes it. Only with that
 * file does the shell also trust the development key, honour the loopback update fixture (main.cjs) and report the key
 * to the page (update.nativeInfo devReleaseKey). The development key string itself is not in this file, so a package
 * without dev-trust.json cannot trust it: the release workflow scans each packaged app for the key and for
 * dev-trust.json (`node tools/release/sign.mjs check-trust`).
 */
const RELEASE_PUBLIC_KEY = 'rIRaOVUyoolaIritW/W8zMW7kGymgcjvg7uXhHtTqPk=';
const RAW_KEY = /^[A-Za-z0-9+/]{43}=$/;
/** SHA-512 (hex) of the raw development key bytes (tools/release/dev-key.mjs keyDigest): dev-trust.json may name only that key. */
const DEV_KEY_SHA512 = '53a585bd98bdf147c51bdc8f4dca645a9d9fe95e3bd662580c7ce3f0e9b67a62019b86085f75980477100aefeb219719a1fe6d58a7bb7e80c9d193f5e081ef03';
const isDevKey = (key) => typeof key === 'string' && RAW_KEY.test(key) && crypto.createHash('sha512').update(Buffer.from(key, 'base64')).digest('hex') === DEV_KEY_SHA512;

/** The development key from a dev-trust.json in `dir`, or null when there is none. Throws when it is malformed. */
function readDevTrust(dir = __dirname) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, 'dev-trust.json'), 'utf8');
  } catch {
    return null;
  }
  let key;
  try {
    key = JSON.parse(text).devReleasePublicKey;
  } catch {}
  if (isDevKey(key)) return key;
  throw new Error('dev-trust.json is malformed or names a key other than the development key; rerun tools/prepare-desktop.mjs.');
}

/** Null in a release build. */
const DEV_RELEASE_PUBLIC_KEY = readDevTrust();
/** Keys this build trusts for signed release files: the release key, plus the dev key in a development build. */
const TRUSTED_KEYS = Object.freeze(DEV_RELEASE_PUBLIC_KEY ? [RELEASE_PUBLIC_KEY, DEV_RELEASE_PUBLIC_KEY] : [RELEASE_PUBLIC_KEY]);
const DEV_KEY_TRUSTED = DEV_RELEASE_PUBLIC_KEY !== null;

const BOOT_TIMEOUT_MS = 20_000;
const MAX_ZIP_BYTES = 512 * 1024 * 1024;
const MAX_TEXT_BYTES = 6 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/* ---------- zip (store + deflate), with zip-slip protection ---------- */

/**
 * Whether a zip entry name is a safe relative path inside the bundle. Refuses absolute paths, drive letters,
 * backslashes, NUL and control characters, "." and ".." segments, empty segments and over-long names.
 */
function safeEntryName(name) {
  if (typeof name !== 'string' || !name || name.length > 512) return false;
  if (/[\\\0\u0001-\u001f\u007f]/.test(name) || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  const parts = name.replace(/\/$/, '').split('/');
  return parts.every((p) => p && p !== '.' && p !== '..');
}

/** Reads the central directory. Throws on anything unsupported or unsafe. */
function zipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('Not a zip file.');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file.');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported.');
  if (count > MAX_ENTRIES) throw new Error('The archive has too many files.');
  if (cdOffset + cdSize > eocd) throw new Error('The archive is damaged.');
  const entries = [];
  let p = cdOffset;
  let total = 0;
  const seen = new Set();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('The archive is damaged.');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const madeBy = buf.readUInt16LE(p + 4) >> 8;
    const external = buf.readUInt32LE(p + 38);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (!safeEntryName(name)) throw new Error(`Unsafe path in the archive: ${JSON.stringify(name.slice(0, 80))}`);
    if (flags & 0x1) throw new Error('Encrypted archives are not supported.');
    const unixMode = madeBy === 3 ? external >>> 16 : 0;
    const type = unixMode & 0o170000;
    if (type === 0o120000) throw new Error(`The archive contains a symbolic link: ${name}`);
    const dir = name.endsWith('/');
    if (type && type !== 0o100000 && type !== 0o040000) throw new Error(`The archive contains a special file: ${name}`);
    if (method !== 0 && method !== 8) throw new Error('The archive uses an unsupported compression method.');
    const key = name.replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) throw new Error(`The archive lists ${name} twice.`);
    seen.add(key);
    total += size;
    if (total > MAX_UNPACKED_BYTES) throw new Error('The archive is too large once unpacked.');
    entries.push({ name, dir, method, compressed, size, local });
  }
  return entries;
}

function entryData(buf, e) {
  const p = e.local;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) throw new Error('The archive is damaged.');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  if (start + e.compressed > buf.length) throw new Error('The archive is damaged.');
  const raw = buf.subarray(start, start + e.compressed);
  const data = e.method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: Math.max(e.size, 1) });
  if (data.length !== e.size) throw new Error(`The archive is damaged (${e.name}).`);
  return data;
}

/** Unpacks into `dest` (created, must not exist). Every path is re-checked to stay inside `dest`. */
function extractZip(buf, dest) {
  const entries = zipEntries(buf);
  fs.mkdirSync(dest, { recursive: false, mode: 0o755 });
  const base = path.resolve(dest);
  for (const e of entries) {
    const target = path.resolve(base, ...e.name.replace(/\/$/, '').split('/'));
    if (!target.startsWith(base + path.sep)) throw new Error(`Unsafe path in the archive: ${e.name}`);
    if (e.dir) {
      fs.mkdirSync(target, { recursive: true, mode: 0o755 });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    // A parent that is a symlink (impossible from this archive, but checked) must not lead outside.
    if (!fs.realpathSync(path.dirname(target)).startsWith(fs.realpathSync(base))) throw new Error(`Unsafe path in the archive: ${e.name}`);
    fs.writeFileSync(target, entryData(buf, e), { flag: 'wx', mode: 0o644 });
  }
  return entries.filter((e) => !e.dir).length;
}

/* ---------- downloads ---------- */

/**
 * GET with redirects followed by hand: the first URL must be an allowed update URL, each redirect must go to GitHub's
 * asset hosts. `fixture` (development builds only, see main.cjs) maps github.com/api.github.com to a loopback server.
 * Returns {status, body: Buffer, etag}.
 */
async function download(url, { fetchImpl = fetch, etag, maxBytes = MAX_ZIP_BYTES, fixture } = {}) {
  if (!isUpdateFetchUrl(url)) throw new Error('That address is not an Agent Empire release.');
  let current = fixture ? fixture.map(url) : url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchImpl(current, {
      redirect: 'manual',
      headers: { 'User-Agent': 'AgentEmpire-Desktop', Accept: url.startsWith('https://api.github.com/') ? 'application/vnd.github+json' : 'application/octet-stream', ...(etag && hop === 0 ? { 'If-None-Match': etag } : {}) },
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const next = res.headers.get('location');
      if (!next) throw new Error('GitHub sent a redirect without a location.');
      const resolved = new URL(next, current).href;
      const allowed = fixture ? fixture.allowsRedirect(resolved) : isAssetRedirect(resolved) || releaseAsset(resolved) !== null;
      if (!allowed) throw new Error('The download was redirected somewhere unexpected.');
      current = resolved;
      continue;
    }
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new Error('The download is too large.');
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > maxBytes) throw new Error('The download is too large.');
    return { status: res.status, body, etag: res.headers.get('etag') };
  }
  throw new Error('Too many redirects.');
}

/** Development fixture: github.com/<path> and api.github.com/<path> → <origin>/<path> and <origin>/api/<path>. */
function fixtureMapper(origin) {
  const u = new URL(origin);
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname) || u.pathname !== '/' || u.search) throw new Error('The update fixture must be a loopback http origin.');
  const base = u.origin;
  return {
    origin: base,
    map: (url) => {
      const x = new URL(url);
      return x.hostname === 'api.github.com' ? `${base}/api${x.pathname}${x.search}` : `${base}${x.pathname}${x.search}`;
    },
    allowsRedirect: (url) => new URL(url).origin === base,
  };
}

/* ---------- the bundle store ---------- */

const EMPTY = Object.freeze({ active: null, knownGood: null, pending: null, trial: null, bad: [] });

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function bundleVersion(dir) {
  const v = readJson(path.join(dir, 'game-version.json'))?.version;
  return isSemver(v) ? v : null;
}

/** A sane state object from whatever is on disk. */
function normalise(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const v = (x) => (isSemver(x) ? x : null);
  const trial = s.trial && isSemver(s.trial.version) && Number.isFinite(s.trial.startedAt) ? { version: s.trial.version, startedAt: s.trial.startedAt } : null;
  return { active: v(s.active), knownGood: v(s.knownGood), pending: v(s.pending), trial, bad: Array.isArray(s.bad) ? s.bad.filter(isSemver).slice(-20) : [] };
}

/**
 * @param {{root: string, builtinRoot: string, now?: () => number}} opts
 */
function createBundleStore({ root, builtinRoot, now = Date.now }) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const statePath = path.join(root, 'state.json');
  let state = normalise(readJson(statePath));
  let rolledBack = null; // one-shot, for nativeInfo
  let installing = null;
  const builtinVersion = bundleVersion(builtinRoot);

  const dirFor = (version) => path.join(root, version);
  const usable = (version) => !!version && fs.existsSync(path.join(dirFor(version), 'index.html')) && bundleVersion(dirFor(version)) === version;
  const save = () => {
    const tmp = `${statePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, statePath);
  };
  /** Never serve an installed bundle that is not newer than the built-in one (e.g. after the app itself updated). */
  const servable = (version) => usable(version) && (!builtinVersion || compareSemver(version, builtinVersion) > 0);

  function rollback(reason) {
    const failed = state.trial?.version ?? state.active;
    if (failed && !state.bad.includes(failed)) state.bad.push(failed);
    rolledBack = failed;
    state.trial = null;
    state.active = state.knownGood && servable(state.knownGood) ? state.knownGood : null;
    save();
    return { rolledBack: failed, reason };
  }

  return {
    builtinVersion,
    get state() {
      return { ...state, bad: [...state.bad] };
    },
    /** Called once when the app starts, before the window loads. */
    launch() {
      let result = null;
      if (state.trial) result = rollback('the previous start never reported booting');
      if (state.pending && servable(state.pending)) {
        state.trial = { version: state.pending, startedAt: now() };
        state.active = state.pending;
        state.pending = null;
      } else if (state.pending) state.pending = null;
      if (state.active && !servable(state.active)) state.active = state.knownGood && servable(state.knownGood) ? state.knownGood : null;
      save();
      return result;
    },
    /** The folder the protocol handler serves: the active bundle, or the built-in one. */
    servingRoot() {
      return state.active && servable(state.active) ? dirFor(state.active) : builtinRoot;
    },
    /** The game version the window shows now. */
    installedGame() {
      return state.active && servable(state.active) ? state.active : builtinVersion;
    },
    takeRolledBack() {
      const v = rolledBack;
      rolledBack = null;
      return v;
    },
    /** Starts the trial of the pending bundle now. Returns false when nothing is pending. */
    activate() {
      if (!state.pending || !servable(state.pending)) return false;
      state.trial = { version: state.pending, startedAt: now() };
      state.active = state.pending;
      state.pending = null;
      save();
      return true;
    },
    /** The page booted. Returns true when this ended a trial. */
    bootOk() {
      const ended = !!state.trial;
      if (state.trial) state.trial = null;
      state.knownGood = state.active;
      save();
      cleanup();
      return ended;
    },
    /** True (and rolled back) when the trial has run 20 s without bootOk. */
    checkTrial() {
      if (!state.trial || now() - state.trial.startedAt < BOOT_TIMEOUT_MS) return false;
      rollback('no boot report within 20 seconds');
      return true;
    },
    /** Why `version` can't be installed, or null. */
    refuse(version) {
      if (!isSemver(version)) return 'Malformed version.';
      const floor = [state.active, state.pending, state.knownGood, builtinVersion].filter(isSemver);
      if (floor.some((v) => compareSemver(version, v) <= 0)) return `Version ${version} is not newer than what this app has.`;
      if (state.bad.includes(version)) return `Version ${version} failed to start before, so it is not installed again.`;
      return null;
    },
    /**
     * Downloads, verifies and unpacks a bundle, then marks it pending. `fetchZip(url)` returns a Buffer.
     */
    async install({ url, sha256, version }, fetchZip) {
      const asset = releaseAsset(url);
      if (!asset || asset.tag === null || !isSha256(sha256)) throw new Error('That update is not an Agent Empire release.');
      const refused = this.refuse(version);
      if (refused) throw new Error(refused);
      if (installing) throw new Error('An update is already being installed.');
      installing = version;
      const tmp = path.join(root, `.tmp-${version}-${crypto.randomBytes(6).toString('hex')}`);
      try {
        const zip = await fetchZip(url);
        const digest = crypto.createHash('sha256').update(zip).digest('hex');
        if (digest !== sha256) throw new Error('The download does not match the signed release (sha256). Nothing was installed.');
        extractZip(zip, tmp);
        if (!fs.existsSync(path.join(tmp, 'index.html'))) throw new Error('The update has no game in it.');
        if (bundleVersion(tmp) !== version) throw new Error('The update’s files are for a different version.');
        const final = dirFor(version);
        fs.rmSync(final, { recursive: true, force: true });
        fs.renameSync(tmp, final);
        // Re-check against the state now (a concurrent change), then commit.
        const again = this.refuse(version);
        if (again) throw new Error(again);
        state.pending = version;
        save();
        return { version };
      } finally {
        installing = null;
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  };

  /** Removes bundles that are neither active, known-good nor pending, and leftover temp folders. */
  function cleanup() {
    const keep = new Set([state.active, state.knownGood, state.pending].filter(Boolean));
    for (const name of fs.readdirSync(root)) {
      if (name === 'state.json' || keep.has(name)) continue;
      if (name.startsWith('.tmp-') && installing) continue;
      if (isSemver(name) || name.startsWith('.tmp-')) fs.rmSync(path.join(root, name), { recursive: true, force: true });
    }
  }
}

/* ---------- native app updates (Electron autoUpdater) ---------- */

/** Squirrel.Windows' Update.exe for an app installed with electron-winstaller: <install>/Update.exe, next to app-<v>/. */
const squirrelUpdateExe = (execPath) => path.resolve(path.dirname(execPath), '..', 'Update.exe');

/** The --squirrel-* event Squirrel.Windows started the app for, or null. */
function squirrelEvent(argv) {
  const flag = (Array.isArray(argv) ? argv : []).find((a) => typeof a === 'string' && a.startsWith('--squirrel-'));
  const name = flag?.slice('--squirrel-'.length).split('=')[0];
  return ['install', 'updated', 'uninstall', 'obsolete', 'firstrun'].includes(name) ? name : null;
}

/**
 * autoUpdater.setFeedURL options for a channel feed: Squirrel.Mac reads a static JSON feed (serverType 'json');
 * Squirrel.Windows reads <folder>/RELEASES, so a RELEASES file URL is given as its folder.
 */
function autoUpdateFeed(platform, feed) {
  if (platform === 'darwin') return { url: feed, serverType: 'json' };
  return { url: String(feed).replace(/\/RELEASES$/, '') };
}

/* ---------- the shell's own check of the signed release (defense in depth) ---------- */

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Ed25519 over `bytes` with a raw 32-byte base64 public key. Never throws. */
function verifyEd25519(bytes, signatureBase64, publicKeyBase64 = RELEASE_PUBLIC_KEY) {
  try {
    const sig = Buffer.from(String(signatureBase64).trim(), 'base64');
    const raw = Buffer.from(publicKeyBase64, 'base64');
    if (sig.length !== 64 || raw.length !== 32) return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(bytes), key, sig);
  } catch {
    return false;
  }
}

/** True when any one of `keys` (default: this build's trusted keys) made the signature; each key is checked on its own. */
function verifyTrusted(bytes, signatureBase64, keys = TRUSTED_KEYS) {
  return (typeof keys === 'string' ? [keys] : keys).some((key) => verifyEd25519(bytes, signatureBase64, key));
}

const RELEASE_REPO = 'Billioncodes001/agent-empire';
/** The signed channel file inside the release tagged v<version> (every release publishes channel-beta.json). */
const releaseChannelUrl = (version) => `https://github.com/${RELEASE_REPO}/releases/download/v${version}/channel-beta.json`;

/**
 * Fetches and verifies the release's own signed channel file with the pinned key, so the shell never relies on the
 * page alone (a script injected into the page could otherwise ask for any published asset). `get(url)` returns
 * {status, body: Buffer}. Returns the parsed document for exactly `version`.
 */
async function signedRelease(version, get, publicKey = TRUSTED_KEYS) {
  if (!isSemver(version)) throw new Error('Malformed version.');
  const url = releaseChannelUrl(version);
  const [doc, sig] = await Promise.all([get(url), get(`${url}.sig`)]);
  if (doc.status !== 200 || sig.status !== 200) throw new Error(`The signed release ${version} could not be read (${doc.status !== 200 ? doc.status : sig.status}).`);
  if (!verifyTrusted(doc.body, sig.body.toString('utf8'), publicKey)) throw new Error('The release’s signature does not match this app’s release key. Nothing was installed.');
  let parsed;
  try {
    parsed = JSON.parse(doc.body.toString('utf8'));
  } catch {
    throw new Error('The signed release is not readable.');
  }
  if (!parsed || parsed.schema !== 1 || parsed.version !== version || (parsed.tag !== undefined && parsed.tag !== `v${version}`)) throw new Error('The signed release is for another version.');
  return parsed;
}

/** The page's installGame request must match the signed release exactly, and the app must be new enough (minShell). */
function checkGameAgainstRelease(release, { url, sha256, version }, shellVersion) {
  const g = release && release.game;
  if (!g || g.url !== url || g.sha256 !== sha256 || release.version !== version) throw new Error('That update does not match the signed release. Nothing was installed.');
  if (!isSemver(g.minShell) || !isSemver(shellVersion) || compareSemver(shellVersion, g.minShell) < 0) throw new Error(`This update needs app version ${g.minShell} or newer.`);
}

/** Squirrel's NuGet version (tools/release/package-windows-installer.mjs nugetVersion): 1.0.0-beta.2 → 1.0.0-beta002. */
function nugetVersion(version) {
  const m = /^(\d+\.\d+\.\d+)(?:-([a-z]+)\.(\d+))?$/.exec(version);
  if (!m) throw new Error(`No Squirrel package for ${version}.`);
  return m[2] ? `${m[1]}-${m[2]}${m[3].padStart(3, '0')}` : m[1];
}

/** The signed release's Windows package: a tagged asset named AgentEmpire-<nuget>-full.nupkg with its sha256. */
function windowsPackage(release, version) {
  const n = release && release.shell && release.shell.windows && release.shell.windows.downloads && release.shell.windows.downloads.x64 && release.shell.windows.downloads.x64.nupkg;
  const name = `AgentEmpire-${nugetVersion(version)}-full.nupkg`;
  const a = n && releaseAsset(n.url);
  if (!a || a.tag !== `v${version}` || a.file !== name || !isSha256(n.sha256)) throw new Error('The signed release has no Windows update package.');
  return { url: n.url, sha256: n.sha256, name };
}

/** A one-line Squirrel RELEASES index for a package we verified ourselves. */
const squirrelReleases = (bytes, name) => `${crypto.createHash('sha1').update(bytes).digest('hex').toUpperCase()} ${name} ${bytes.length}\r\n`;

module.exports = { verifyEd25519, verifyTrusted, readDevTrust, DEV_KEY_SHA512, TRUSTED_KEYS, DEV_KEY_TRUSTED, releaseChannelUrl, signedRelease, checkGameAgainstRelease, nugetVersion, windowsPackage, squirrelReleases, squirrelUpdateExe, squirrelEvent, autoUpdateFeed, RELEASE_PUBLIC_KEY, DEV_RELEASE_PUBLIC_KEY, BOOT_TIMEOUT_MS, MAX_TEXT_BYTES, safeEntryName, zipEntries, extractZip, download, fixtureMapper, createBundleStore, bundleVersion };
