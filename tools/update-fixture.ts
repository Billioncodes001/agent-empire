/**
 * A local stand-in for GitHub releases, for in-app update checks only (REL-03/04/05). It serves signed channel files,
 * game zips, a coordinator and the releases listing at the same paths github.com and api.github.com use, so the app
 * sends real release URLs and the shells map them here:
 *
 *   desktop  --empire-update-fixture=http://127.0.0.1:<port>      (development build: prepare-desktop.mjs --dev-updates)
 *   Android  adb shell am start ... --es ae.debug.updates http://10.0.2.2:<port>   (debug variant)
 *   iOS      simctl launch ... -AE_UPDATE_FIXTURE http://127.0.0.1:<port>          (Debug build)
 *
 * Everything is signed with the PUBLIC development key (tests/update-fixtures.ts), which only development builds trust
 * (REL-07): release builds trust only the owner's key and ignore the fixture, and the release gate refuses any release
 * build that would trust the development key.
 *
 *   npm run build:client && UPDATE_FIXTURE_PORT=4719 npx tsx tools/update-fixture.ts
 *
 * Releases offered (the game zips are the real dist/public with game-version.json rewritten):
 *   GOOD   (default 0.1.1)  the real game: boots and reports update.bootOk
 *   BROKEN (default 0.1.2)  an index.html that never boots, to prove the 20 s rollback
 *   OLDER  (optional, UPDATE_OLDER) the real game relabelled as a LOWER version, for downgrade checks
 * POST /__fixture/latest/<version> chooses which one is the latest stable release; /__fixture shows the state.
 * GET /__fixture?since=<count> lists the requests since an earlier `count`.
 * POST /__fixture/tamper/<off|page|shell|all> alters files after signing so their signatures no longer match:
 *   page   channel-stable.json (what the page reads through `latest`)
 *   shell  channel-beta.json (what each shell reads from the tagged release before installing)
 * UPDATE_APK=<file> also publishes that APK as the GOOD release's Android app (shell.android url/sha256, debug-signed).
 * Download URLs answer with a 302 to /__assets/… on this origin, so the shells' redirect handling is exercised.
 */
import { createServer, type Server } from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { RELEASE_REPO } from '../src/client/update/channel';
import { asset, channelJson, makeZip, sha256, sign, type ZipFile } from '../tests/update-fixtures';

export interface FixtureRelease {
  version: string;
  zip: Buffer;
  broken: boolean;
}

/** game-version.json with a new version and everything else kept (DEVICE-BUGS-03: the `build` the app shows). */
function relabel(text: string, version: string): string {
  let doc: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) doc = parsed;
  } catch {}
  return `${JSON.stringify({ ...doc, version })}\n`;
}

/** The real game from `dir` (dist/public), relabelled as `version`. */
export function gameZipFrom(dir: string, version: string): Buffer {
  const files: ZipFile[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith('.')) continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = relative(dir, full).split('\\').join('/');
        files.push({ name: rel, data: rel === 'game-version.json' ? relabel(readFileSync(full, 'utf8'), version) : readFileSync(full) });
      }
    }
  };
  walk(dir);
  if (!files.some((f) => f.name === 'index.html')) throw new Error(`${dir} has no index.html: run npm run build:client first`);
  if (!files.some((f) => f.name === 'game-version.json')) files.push({ name: 'game-version.json', data: `${JSON.stringify({ version })}\n` });
  return makeZip(files);
}

/** A bundle whose page never boots (no game code): the shell must roll it back after 20 s. */
export function brokenZip(version: string): Buffer {
  return makeZip([
    { name: 'index.html', data: `<!doctype html><html><head><meta charset="utf-8"><title>Broken ${version}</title></head><body style="background:#300;color:#fff;font:20px system-ui">Broken update ${version}: this page never reports booting.</body></html>` },
    { name: 'game-version.json', data: JSON.stringify({ version }) },
  ]);
}

export interface UpdateFixtureOptions {
  port: number;
  host?: string;
  game: string;
  good?: string;
  broken?: string;
  minShell?: string;
  coordinator?: string | null;
  notes?: string;
  older?: string;
  /** An APK published as the GOOD release's sideload Android app. */
  apk?: Buffer;
}

export type TamperMode = 'off' | 'page' | 'shell' | 'all';

export function startUpdateFixture(opts: UpdateFixtureOptions): Promise<{ server: Server; origin: string; releases: Map<string, FixtureRelease>; setLatest(v: string): void; setTamper(m: TamperMode): void; log: string[] }> {
  if (opts.port === 4610) throw new Error('Never 4610.');
  const good = opts.good ?? '0.1.1', broken = opts.broken ?? '0.1.2';
  const releases = new Map<string, FixtureRelease>([
    [good, { version: good, zip: gameZipFrom(opts.game, good), broken: false }],
    [broken, { version: broken, zip: brokenZip(broken), broken: true }],
  ]);
  if (opts.older) releases.set(opts.older, { version: opts.older, zip: gameZipFrom(opts.game, opts.older), broken: false });
  let tamper: TamperMode = 'off';
  const apkName = (_v: string) => 'Agent-Empire-Android.apk'; // signing state is in the channel (signed: false), not the name
  const coordinator = opts.coordinator === undefined ? readFileSync(join(opts.game, 'cloud/agent-empire-coordinator.mjs'), 'utf8') : opts.coordinator;
  let latest = good;
  const log: string[] = [];
  const channelFor = (version: string) => {
    const r = releases.get(version)!;
    const android = opts.apk && version === good ? { name: apkName(version), url: asset(version, apkName(version)), sha256: sha256(opts.apk), signed: false, play: null } : undefined;
    const doc = channelJson({ version, gameSha: sha256(r.zip), minShell: opts.minShell ?? '0.1.0', coordinatorSha: coordinator ? sha256(coordinator) : undefined, android, notes: opts.notes ?? (r.broken ? `Fixture ${version}: a deliberately broken bundle (rollback check).` : `Fixture ${version}: the same city, delivered as a signed over-the-air update.\nSaves and settings are not changed.`) });
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    return { text, sig: `${sign(text)}\n` };
  };
  /** The served text: signed, then altered when tampering applies to this file (same JSON shape, wrong signature). */
  const served = (text: string, file: 'page' | 'shell') => (tamper === 'all' || tamper === file ? text.replace('"notes": "', '"notes": "TAMPERED after signing. ') : text);
  const prefix = `/${RELEASE_REPO}/releases`;
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://fixture');
    const p = decodeURIComponent(url.pathname);
    log.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (status: number, body: string | Buffer, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
    };
    if (p === '/__fixture') return send(200, JSON.stringify({ latest, good, broken, older: opts.older ?? null, tamper, apk: !!opts.apk, releases: [...releases.keys()], count: log.length, requests: url.searchParams.has('since') ? log.slice(Number(url.searchParams.get('since')) || 0) : log.slice(-40) }, null, 2));
    const tamperPick = /^\/__fixture\/tamper\/(off|page|shell|all)$/.exec(p);
    if (tamperPick && req.method === 'POST') {
      tamper = tamperPick[1] as TamperMode;
      return send(200, `tamper is ${tamper}`, 'text/plain');
    }
    const pick = /^\/__fixture\/latest\/([^/]+)$/.exec(p);
    if (pick && req.method === 'POST') {
      if (!releases.has(pick[1])) return send(404, 'unknown version', 'text/plain');
      latest = pick[1];
      return send(200, `latest is ${latest}`, 'text/plain');
    }
    if (p === `/api/repos/${RELEASE_REPO}/releases`) return send(200, JSON.stringify([...releases.keys()].map((v) => ({ tag_name: `v${v}`, draft: false, prerelease: false, assets: [] }))));
    const latestFile = new RegExp(`^${prefix}/latest/download/(channel-stable\\.json(?:\\.sig)?)$`).exec(p);
    if (latestFile) return redirect(`v${latest}`, latestFile[1]);
    const tagged = new RegExp(`^${prefix}/download/v([^/]+)/([^/]+)$`).exec(p);
    if (tagged) return redirect(`v${tagged[1]}`, tagged[2]);
    const assetPath = /^\/__assets\/v([^/]+)\/([^/]+)$/.exec(p);
    if (assetPath) {
      const r = releases.get(assetPath[1]);
      if (!r) return send(404, 'Not Found', 'text/plain');
      const name = assetPath[2];
      if (name === 'channel-stable.json') return send(200, served(channelFor(r.version).text, 'page'));
      if (name === 'channel-beta.json') return send(200, served(channelFor(r.version).text, 'shell'));
      if (name === 'channel-stable.json.sig' || name === 'channel-beta.json.sig') return send(200, channelFor(r.version).sig, 'text/plain');
      if (name === `agent-empire-game-${r.version}.zip`) return send(200, r.zip, 'application/zip');
      if (opts.apk && r.version === good && name === apkName(r.version)) return send(200, opts.apk, 'application/vnd.android.package-archive');
      if (name === 'agent-empire-coordinator.mjs' && coordinator) return send(200, coordinator, 'text/javascript');
      return send(404, 'Not Found', 'text/plain');
    }
    send(404, 'Not Found', 'text/plain');

    function redirect(tag: string, file: string) {
      res.writeHead(302, { Location: `/__assets/${tag}/${encodeURIComponent(file)}`, 'Cache-Control': 'no-store' });
      res.end();
    }
  });
  return new Promise((ok) =>
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => {
      const origin = `http://127.0.0.1:${opts.port}`;
      ok({ server, origin, releases, setLatest: (v) => (latest = v), setTamper: (m) => (tamper = m), log });
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const port = Number(process.env.UPDATE_FIXTURE_PORT || 4719);
  const host = process.env.UPDATE_FIXTURE_HOST || '127.0.0.1';
  const game = resolve(import.meta.dirname, '../dist/public');
  const fx = await startUpdateFixture({ port, host, game, good: process.env.UPDATE_GOOD, broken: process.env.UPDATE_BROKEN, older: process.env.UPDATE_OLDER, apk: process.env.UPDATE_APK ? readFileSync(process.env.UPDATE_APK) : undefined });
  for (const r of fx.releases.values()) console.log(`release ${r.version}${r.broken ? ' (broken)' : ''}: ${(r.zip.length / 1e6).toFixed(1)} MB, sha256 ${sha256(r.zip).slice(0, 12)}…`);
  console.log(`update fixture on http://${host}:${port} (dev-signed; shells honour it only with the development key)`);
}
