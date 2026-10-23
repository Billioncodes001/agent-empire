/**
 * Agent Empire desktop shell (APP-05). One game window loads the bundled client from empire-app://game (the same
 * origin as the iOS app, already allowed by the server's APP_ORIGINS). First launch shows the shared setup
 * ("Run in the cloud with my accounts" / "Connect my own server"). The desktop also offers "Run on this computer":
 * the bundled local server, signed in natively, with full capabilities while the app is open.
 *
 * The page talks to the shell only through window.empireDesktop (preload.cjs) under the bridge contract in
 * docs/team/CLOUD_MODE_PLAN.md; every request is checked here with bridge-policy.cjs.
 */
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, session, safeStorage, protocol, net, clipboard, autoUpdater } = require('electron');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('node:fs');
const { execFile } = require('node:child_process');
const policy = require('./bridge-policy.cjs');
const { createHandler } = require('./app-protocol.cjs');
const { createSecureStore } = require('./secure-store.cjs');
const { runDeviceFlow } = require('./device-flow.cjs');
const { createVault, HOSTED } = require('./credential-vault.cjs');
const { startLocalHost, localDeviceSession } = require('./local-host.cjs');
const updates = require('./update-store.cjs');

// Squirrel.Windows (electron-winstaller, installer id AgentEmpire) starts the app with --squirrel-* once per install,
// update, uninstall and obsolete version: maintain the shortcuts with its Update.exe and quit at once, before any
// window or server starts (the standard electron-squirrel-startup handling, without the dependency).
const squirrelEvent = process.platform === 'win32' ? updates.squirrelEvent(process.argv) : null;
const squirrelOnly = !!squirrelEvent && squirrelEvent !== 'firstrun';
if (squirrelOnly) {
  const exe = path.basename(process.execPath);
  const args = squirrelEvent === 'install' || squirrelEvent === 'updated' ? ['--createShortcut', exe] : squirrelEvent === 'uninstall' ? ['--removeShortcut', exe] : null;
  if (args)
    try {
      require('node:child_process').spawn(updates.squirrelUpdateExe(process.execPath), args, { detached: true, stdio: 'ignore' }).unref();
    } catch (error) {
      console.warn('Squirrel shortcut update failed:', error.message);
    }
  setTimeout(() => app.quit(), 1000);
}

process.env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].filter(Boolean).join(path.delimiter);
// An explicit --user-data-dir (isolated test profiles) moves everything, including the single-instance lock.
if (app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', path.resolve(app.commandLine.getSwitchValue('user-data-dir')));
protocol.registerSchemesAsPrivileged([
  { scheme: policy.APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

const GAME_URL = `${policy.APP_ORIGIN}/`;
const PARTITION = 'persist:empire-game';
const BACKGROUND = '#0c161b';
const deviceUrl = pathToFileURL(path.join(__dirname, 'device.html')).href;
const credentialsUrl = pathToFileURL(path.join(__dirname, 'credentials.html')).href;
const deviceName = () => os.hostname().replace(/\.local$/i, '').slice(0, 64) || 'Desktop app';

let win, store, vault, syncEngine;
let localHost, localSession; // "This computer": the bundled server and its in-memory device session
let pendingSignedOut; // one-shot reason for the next page config
let lastGesture = 0;
let deviceFlow; // {controller, info, window}
let credentialsWindow;
let busy = false, syncTimer;
let bundles; // in-app game updates (update-store.cjs)
let trialTimer;
let updateFixture; // development only: a loopback stand-in for GitHub releases (see setUpUpdates)

/* ---------- small persisted settings (not secret) ---------- */
const configPath = () => path.join(app.getPath('userData'), 'connection.json');
function readConfig() {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}
function saveConfig(value) {
  mkdirSync(path.dirname(configPath()), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), JSON.stringify(value), { mode: 0o600 });
}
const storeGet = (key) => {
  try {
    return store.get(key);
  } catch {
    return null;
  }
};

/**
 * One-time move from the old launcher (shell v1): a local city opens again as "This computer"; a remote host
 * becomes the server path with its address prefilled (its old cookie session can't become a device token, so the
 * player signs in once). Local projects are never moved or deleted.
 */
function migrateFromLauncher() {
  const c = readConfig();
  if (c.shell === 2) return;
  const next = { ...c, shell: 2 };
  if (!storeGet('mode')) {
    try {
      if (c.lastMode === 'local' && c.localProject) next.runMode = 'local';
      else if (c.lastMode === 'remote' && policy.serverOrigin(c.origin) === c.origin) {
        store.set('server.host', c.origin);
        store.set('mode', 'server');
      }
    } catch (error) {
      console.warn('Setup migration skipped:', error.message);
    }
  }
  saveConfig(next);
}

/* ---------- page config and the bridge ---------- */
function pageConfig() {
  let snap = {};
  try {
    snap = store.snapshot();
  } catch {}
  const s = localSession;
  const cfg = policy.configFor({
    deviceName: deviceName(),
    mode: s ? 'local' : snap.mode,
    host: s ? s.host : snap['server.host'],
    token: s ? s.token : snap['server.token'],
    deviceId: s ? s.deviceId : snap['server.deviceId'],
    signedOut: pendingSignedOut,
    local: !!s,
    localAvailable: true,
  });
  pendingSignedOut = undefined;
  return cfg;
}

const fromGame = (event) => !!win && !win.isDestroyed() && event.senderFrame === win.webContents.mainFrame && policy.isAppUrl(event.senderFrame.url);

async function handleBridge(request) {
  switch (request.method) {
    case 'secure.get':
      if (localSession && request.params.key === 'server.token') return localSession.token;
      if (localSession && request.params.key === 'server.deviceId') return localSession.deviceId;
      return store.get(request.params.key);
    case 'secure.set':
      // Signing in to another server, or choosing another mode, leaves "This computer".
      if (localSession && request.params.key === 'server.host' && request.params.value !== localSession.host) leaveLocal();
      if (localSession && request.params.key === 'mode' && request.params.value !== 'local') leaveLocal();
      store.set(request.params.key, request.params.value);
      return true;
    case 'secure.delete':
      store.delete(request.params.key);
      return true;
    case 'github.deviceFlow':
      return githubDeviceFlow(request.params);
    case 'app.signedOut':
      await signedOut(request.params.reason);
      return true;
    case 'app.openExternal':
      return openExternal(request.params.url);
    case 'update.fetch': {
      const r = await updates.download(request.params.url, { etag: request.params.etag, maxBytes: updates.MAX_TEXT_BYTES, fixture: updateFixture });
      return { status: r.status, body: r.body.toString('utf8'), etag: r.etag };
    }
    case 'update.installGame': {
      // Defense in depth: the shell reads the release's own signed channel and installs only what it names.
      const release = await updates.signedRelease(request.params.version, (url) => updates.download(url, { fixture: updateFixture, maxBytes: updates.MAX_TEXT_BYTES }));
      updates.checkGameAgainstRelease(release, request.params, app.getVersion());
      return bundles.install(request.params, async (url) => {
        const r = await updates.download(url, { fixture: updateFixture });
        if (r.status !== 200) throw new Error(`GitHub answered ${r.status} for the update.`);
        return r.body;
      });
    }
    case 'update.activate':
      if (!bundles.activate()) throw new Error('No update is waiting.');
      // Answer first, then restart the game into the new bundle (a trial until it reports booting).
      setTimeout(() => {
        armTrial();
        if (win && !win.isDestroyed()) void win.loadURL(GAME_URL).catch(() => {});
      }, 50);
      return true;
    case 'update.bootOk':
      bundles.bootOk();
      clearTimeout(trialTimer);
      return true;
    case 'update.nativeInfo': {
      const rolledBack = bundles.takeRolledBack();
      return {
        platform: 'desktop',
        shellVersion: app.getVersion(),
        os: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
        arch: process.arch === 'arm64' ? 'arm64' : 'x64',
        installedGame: bundles.installedGame(),
        builtinGame: bundles.builtinVersion,
        pendingGame: bundles.state.pending,
        canInstallGame: true,
        canAutoUpdate: await canAutoUpdate(),
        ...(rolledBack ? { rolledBack } : {}),
        ...(updates.DEV_KEY_TRUSTED ? { devReleaseKey: updates.DEV_RELEASE_PUBLIC_KEY } : {}),
      };
    }
    case 'update.openNative':
      return openNativeUpdate(request.params);
    case 'app.runLocal': {
      const outcome = await confirmAndStartLocal();
      if (outcome === 'cancelled') throw new Error('cancelled: Running on this computer was cancelled. Nothing was started.');
      menu();
      // The page adopts this session without a reload (like the server path); the config carries it on relaunch.
      return { mode: 'local', host: localSession.host, token: localSession.token, deviceId: localSession.deviceId };
    }
  }
  throw new Error('Unknown method.');
}

async function signedOut(reason) {
  if (localSession) {
    if (reason === 'user') {
      // Signing out of "This computer" returns to the setup; the local project stays on disk.
      leaveLocal();
      for (const key of ['mode', 'server.host']) store.delete(key);
    } else {
      localSession = undefined; // re-signed in natively below
    }
  }
  store.clearSession();
  pendingSignedOut = reason;
  setTimeout(() => void reloadGame(), 50);
}

async function openExternal(url) {
  const now = Date.now();
  if (!policy.gestureAllows(lastGesture, now)) {
    const choice = await dialog.showMessageBox(win, { type: 'question', buttons: ['Cancel', 'Open in browser'], defaultId: 1, cancelId: 0, message: 'Open this page in your browser?', detail: url });
    if (choice.response !== 1) throw new Error('Not opened.');
  }
  lastGesture = 0; // one gesture opens one page
  await shell.openExternal(url);
  return true;
}

/* ---------- in-app updates (REL-04) ---------- */
/**
 * The bundle store, the 20 s rollback timer and the optional development fixture. The fixture
 * (--empire-update-fixture=http://127.0.0.1:<port>) is honoured only by a development build, which trusts the public dev
 * key (update-store.cjs DEV_KEY_TRUSTED: prepared with --dev-updates), so a release build never downloads from anywhere
 * but GitHub.
 */
async function setUpUpdates() {
  bundles = updates.createBundleStore({ root: path.join(app.getPath('userData'), 'game-bundles'), builtinRoot: path.join(__dirname, 'runtime', 'public') });
  const launched = bundles.launch();
  if (launched) console.warn(`Game update ${launched.rolledBack} rolled back: ${launched.reason}`);
  const fixture = app.commandLine.getSwitchValue('empire-update-fixture');
  if (fixture) {
    if (updates.DEV_KEY_TRUSTED) {
      updateFixture = updates.fixtureMapper(fixture);
      console.warn(`Update fixture: release downloads come from ${updateFixture.origin} (development key only).`);
    } else console.warn('Ignoring --empire-update-fixture: this is a release build (it trusts only the release key).');
  }
}

function armTrial() {
  clearTimeout(trialTimer);
  const trial = bundles.state.trial;
  if (!trial) return;
  trialTimer = setTimeout(() => {
    if (bundles.checkTrial()) {
      console.warn('The updated game did not report booting within 20 s; rolled back.');
      void reloadGame();
    }
  }, Math.max(0, trial.startedAt + updates.BOOT_TIMEOUT_MS - Date.now()) + 50);
}

let autoUpdateCapable;
/**
 * Electron's built-in autoUpdater works only for a signed app: macOS (Squirrel.Mac) needs a packaged app signed with
 * Developer ID; Windows (Squirrel.Windows, electron-winstaller) needs the app to run from its Squirrel install, where
 * Update.exe sits next to the app folder.
 */
function canAutoUpdate() {
  if (autoUpdateCapable !== undefined) return Promise.resolve(autoUpdateCapable);
  if (!app.isPackaged) return Promise.resolve((autoUpdateCapable = false));
  if (process.platform === 'win32') return Promise.resolve((autoUpdateCapable = existsSync(updates.squirrelUpdateExe(process.execPath))));
  if (process.platform !== 'darwin') return Promise.resolve((autoUpdateCapable = false));
  const bundle = path.resolve(process.execPath, '..', '..', '..');
  return new Promise((resolve) =>
    execFile('codesign', ['-dv', '--verbose=2', bundle], { timeout: 10_000 }, (_error, _out, err) => resolve((autoUpdateCapable = /Authority=Developer ID Application/.test(String(err))))),
  );
}

/**
 * The feed the autoUpdater may use, taken from the release's own signed channel (never from the page):
 *   macOS    the signed release's Squirrel.Mac feed for this architecture (Squirrel.Mac also checks the code signature)
 *   Windows  Squirrel.Windows doesn't verify Authenticode, so the shell downloads the nupkg named in the signed release
 *            (its tag, not "latest"), checks its sha256, and points Squirrel at a local folder holding only that
 *            package and a RELEASES index computed here. An unverified package is never applied.
 */
async function verifiedFeed(release, version) {
  if (process.platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const feed = release.shell && release.shell.macos && release.shell.macos.auto === true && release.shell.macos.feed && release.shell.macos.feed[arch];
    if (typeof feed !== 'string' || !(policy.releaseAsset(feed) || policy.isMacLatestFeed(feed))) throw new Error('The signed release has no macOS update feed.');
    return updates.autoUpdateFeed('darwin', feed);
  }
  const pkg = updates.windowsPackage(release, version);
  const r = await updates.download(pkg.url, { fixture: updateFixture });
  if (r.status !== 200) throw new Error(`GitHub answered ${r.status} for the app update.`);
  if (require('node:crypto').createHash('sha256').update(r.body).digest('hex') !== pkg.sha256) throw new Error('The app update does not match the signed release (sha256). Nothing was installed.');
  const dir = path.join(app.getPath('userData'), 'squirrel-feed');
  require('node:fs').rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, pkg.name), r.body);
  writeFileSync(path.join(dir, 'RELEASES'), updates.squirrelReleases(r.body, pkg.name));
  return { url: dir };
}

/** 'idle' | 'downloading' | 'ready' (downloaded; the next openNative restarts into it). */
let nativeUpdate = 'idle';
/**
 * update.openNative on desktop. A signed app updates itself with Electron's autoUpdater from the channel's feed: the
 * call answers 'auto-update' once the update is downloaded, and the page then offers "Restart to update", which calls
 * again ('restart'). Anything else (unsigned, no feed, an updater error) opens the release page in the browser.
 */
async function openNativeUpdate({ version, url, feed }) {
  if (nativeUpdate === 'ready') {
    setTimeout(() => autoUpdater.quitAndInstall(), 100);
    return { action: 'restart' };
  }
  if (feed && (await canAutoUpdate())) {
    if (nativeUpdate === 'downloading') throw new Error('The app update is already downloading.');
    nativeUpdate = 'downloading';
    try {
      if (!policy.isSemver(version) || policy.compareSemver(version, app.getVersion()) <= 0) throw new Error(`${version} is not newer than this app.`);
      const release = await updates.signedRelease(version, (u) => updates.download(u, { fixture: updateFixture, maxBytes: updates.MAX_TEXT_BYTES }));
      const feedOptions = await verifiedFeed(release, version);
      await new Promise((resolve, reject) => {
        autoUpdater.removeAllListeners();
        autoUpdater.once('error', reject);
        autoUpdater.once('update-not-available', () => reject(new Error(`The update feed has no newer app than ${app.getVersion()}.`)));
        autoUpdater.once('update-downloaded', resolve);
        autoUpdater.setFeedURL(feedOptions);
        autoUpdater.checkForUpdates();
      });
      nativeUpdate = 'ready';
      return { action: 'auto-update' };
    } catch (error) {
      nativeUpdate = 'idle';
      console.warn(`The app could not update itself to ${version}: ${error.message}`);
      // Fall through to the release page.
    }
  }
  if (!url) throw new Error('This update has no download for this computer.');
  await openExternal(url);
  return { action: 'opened' };
}

/* ---------- GitHub device flow (main process; the page never sees the device code exchange) ---------- */
function githubDeviceFlow({ clientId, scope }) {
  if (deviceFlow) throw new Error('invalid_request: GitHub sign-in is already in progress.');
  const controller = new AbortController();
  const state = (deviceFlow = { controller, info: null, window: null });
  const finish = () => {
    if (deviceFlow === state) deviceFlow = undefined;
    if (state.window && !state.window.isDestroyed()) state.window.close();
  };
  return runDeviceFlow({
    clientId,
    scope,
    signal: controller.signal,
    fetch: (url, init) => net.fetch(url, init),
    onCode: (info) => {
      state.info = info;
      state.window = new BrowserWindow({
        parent: win, modal: true, show: false, width: 520, height: 500, resizable: false, minimizable: false, fullscreenable: false,
        title: 'Sign in with GitHub', backgroundColor: BACKGROUND,
        webPreferences: { preload: path.join(__dirname, 'device-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'device-code' },
      });
      lockDown(state.window, deviceUrl);
      state.window.once('ready-to-show', () => state.window?.show());
      state.window.on('closed', () => controller.abort());
      void state.window.loadURL(deviceUrl);
    },
  }).finally(finish);
}

function lockDown(window, onlyUrl) {
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => url !== onlyUrl && event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}

/* ---------- "This computer" ---------- */
function leaveLocal() {
  localSession = undefined;
  const c = readConfig();
  if (c.runMode) saveConfig({ ...c, runMode: undefined });
  if (localHost && !localHost.hasLocalWorkers()) {
    localHost.shutdown();
    localHost = undefined;
  }
}

async function startLocal(project) {
  const c = readConfig();
  if (localHost && localHost.project !== project) throw new Error('Quit and reopen the app before switching to another local project.');
  if (!localHost)
    localHost = await startLocalHost({
      project,
      runtimeDir: path.join(__dirname, 'runtime'),
      credentials: () => vault.read(),
      port: c.localProject === project ? c.localPort : undefined,
    });
  localSession = await localDeviceSession(localHost, deviceName(), (url, init) => net.fetch(url, init));
  store.set('server.host', localSession.host);
  store.set('mode', 'local', { trusted: true }); // only after the player confirmed (confirmAndStartLocal / migration)
  for (const key of ['server.token', 'server.deviceId']) store.delete(key); // a remote sign-in is replaced
  saveConfig({ ...readConfig(), runMode: 'local', localProject: project, localPort: localHost.port });
}

let localStarting = false;
/**
 * The one "Run on this computer" flow, for the menu and for the page's app.runLocal: the confirmation dialog that
 * says it runs only while the app is open, then the bundled server and a native sign-in. Returns 'started' (also
 * when it is already running) or 'cancelled'; throws with a plain message when the server can't start.
 */
async function confirmAndStartLocal() {
  if (localSession) return 'started';
  if (localStarting || busy) throw new Error('The app is busy. Try again in a moment.');
  localStarting = true;
  try {
    const c = readConfig();
    const project = c.localProject || path.join(app.getPath('userData'), 'city-project');
    const choice = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Cancel', 'Choose project folder…', 'Run on this computer'],
      defaultId: 2,
      cancelId: 0,
      message: 'Run your Empire on this computer?',
      detail:
        'The Empire runs inside this app, with full capabilities: live terminals, service tunnels and local agents.\n\n' +
        'It runs only while the app is open. When you quit, local workers stop and nothing happens until you open the app again. For an Empire that keeps working while this computer is off, use the cloud or your own server instead.\n\n' +
        'Workers stay paused until you choose where they run inside the game.\n\n' +
        `Project: ${project}`,
    });
    if (choice.response === 0) return 'cancelled';
    let chosen = project;
    if (choice.response === 1) {
      const picked = await dialog.showOpenDialog(win, { title: 'Choose a Git project or an empty folder for your city', properties: ['openDirectory', 'createDirectory'] });
      if (picked.canceled) return 'cancelled';
      chosen = picked.filePaths[0];
    }
    try {
      await startLocal(chosen);
    } catch (error) {
      localSession = undefined;
      throw new Error(`The Empire couldn’t start on this computer: ${error.message}`);
    }
    return 'started';
  } finally {
    localStarting = false;
  }
}

async function runOnThisComputer() {
  let outcome;
  try {
    outcome = await confirmAndStartLocal();
  } catch (error) {
    await dialog.showMessageBox(win, { type: 'warning', message: 'The Empire couldn’t start on this computer', detail: error.message });
    return;
  }
  if (outcome === 'started') await reloadGame();
}

async function resumeLocal() {
  const c = readConfig();
  if (!policy.shouldResumeLocal(c)) return; // connection.json only: the page can't write it
  try {
    await startLocal(c.localProject);
  } catch (error) {
    localSession = undefined;
    dialog.showErrorBox('The Empire on this computer didn’t start', `${error.message}\n\nUse Empire → Run on this computer… to try again, or Change setup.`);
  }
}

async function changeSetup() {
  if (localHost?.hasLocalWorkers()) {
    await dialog.showMessageBox(win, { type: 'info', message: 'Stop the local workers first', detail: 'Workers are still running in the Empire on this computer.' });
    return;
  }
  const choice = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Cancel', 'Change setup'], defaultId: 0, cancelId: 0,
    message: 'Forget this computer’s setup?',
    detail: 'This computer forgets how it connects and returns to the setup. Your Empire itself is not changed: a cloud Empire keeps running in your GitHub, a server keeps running, and a local project stays on disk.',
  });
  if (choice.response !== 1) return;
  leaveLocal();
  try {
    store.clearAll();
  } catch {}
  await reloadGame();
}

/* ---------- provider keys (local mode only, as before) ---------- */
function showCredentials() {
  if (credentialsWindow && !credentialsWindow.isDestroyed()) return credentialsWindow.focus();
  credentialsWindow = new BrowserWindow({
    parent: win, show: false, width: 520, height: 640, minWidth: 380, title: 'Provider keys', backgroundColor: BACKGROUND,
    webPreferences: { preload: path.join(__dirname, 'credentials-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'provider-keys' },
  });
  lockDown(credentialsWindow, credentialsUrl);
  credentialsWindow.once('ready-to-show', () => credentialsWindow.show());
  void credentialsWindow.loadURL(credentialsUrl);
}

/* ---------- server sync (unchanged features, now with the device token) ---------- */
function serverSession() {
  if (localSession) return localSession;
  const host = storeGet('server.host'), token = storeGet('server.token');
  return storeGet('mode') === 'server' && host && token ? { host, token } : undefined;
}
async function request(url, init = {}) {
  const s = serverSession();
  if (!s) throw new Error('Connect to a server or run the Empire on this computer first.');
  return net.fetch(s.host + url, { ...init, redirect: 'error', signal: AbortSignal.timeout(60000), headers: { ...init.headers, Authorization: `Bearer ${s.token}` } });
}
async function json(url, init) {
  return JSON.parse((await syncEngine.readBounded(await request(url, init), 4 * 1024 * 1024)).toString());
}
async function synchronize(automatic = false) {
  const s = serverSession();
  if (busy || !s) return;
  const config = readConfig();
  if (!config.repo || config.origin !== s.host) {
    if (!automatic) await configureSync();
    return;
  }
  busy = true;
  try {
    const list = await json('/api/sync/artifacts');
    syncEngine.pinServer(config.repo, s.host, list.serverId);
    let imported = 0, conflicts = 0;
    for (const value of list.artifacts) {
      const m = syncEngine.validateManifest(value, list.serverId);
      const bytes = await syncEngine.readBounded(await request(m.bundle.url), syncEngine.MAX_BUNDLE_BYTES);
      const receipt = syncEngine.importArtifact(config.repo, m, bytes, list.serverId);
      if (!receipt.reused) imported++;
      conflicts += receipt.conflicts.length;
    }
    if (!automatic || imported)
      await dialog.showMessageBox(win, { type: 'info', message: `${imported} new worktree${imported === 1 ? '' : 's'} ready for review`, detail: `${conflicts} overlapping local file changes. Your active branch and edits were preserved.\nUse File → Open sync inbox to inspect the work.` });
  } catch (error) {
    if (!automatic || !String(error.message).includes('(401)')) await dialog.showMessageBox(win, { type: 'warning', message: 'Synchronization needs attention', detail: error.message });
  } finally {
    busy = false;
  }
}
async function configureSync() {
  const s = serverSession();
  if (!s) return dialog.showMessageBox(win, { type: 'info', message: 'Synchronization needs a server', detail: 'Connect to your own server or run the Empire on this computer first.' });
  try {
    const list = await json('/api/sync/artifacts');
    const chosen = await dialog.showOpenDialog(win, { title: 'Choose the laptop project repository', properties: ['openDirectory'] });
    if (chosen.canceled) return;
    const decision = await dialog.showMessageBox(win, {
      type: 'question', buttons: ['Cancel', 'Trust host and enable sync'], defaultId: 0, cancelId: 0,
      message: 'Import published work from this host?',
      detail: `${s.host}\nHost ID: ${list.serverId}\n\nNew work goes into isolated review worktrees. Nothing is merged into your active branch. Reopening the app will check for published work.`,
      checkboxLabel: 'Also check for new published work every minute while this app is open', checkboxChecked: false,
    });
    if (decision.response !== 1) return;
    syncEngine.pinServer(chosen.filePaths[0], s.host, list.serverId, list.serverId);
    saveConfig({ ...readConfig(), origin: s.host, repo: chosen.filePaths[0], autoSync: decision.checkboxChecked });
    startSyncTimer();
    await synchronize();
  } catch (error) {
    await dialog.showMessageBox(win, { type: 'error', message: 'Could not configure synchronization', detail: error.message });
  }
}
function startSyncTimer() {
  clearInterval(syncTimer);
  if (readConfig().autoSync) syncTimer = setInterval(() => void synchronize(true), 60000);
}
async function publish() {
  try {
    const feed = await json('/api/continuity/events?after=0');
    const workers = (feed.snapshot?.workers || []).filter((w) => w.kind === 'agent' && w.processState === 'stopped' && w.worktree).slice(0, 12);
    if (!workers.length) return dialog.showMessageBox(win, { message: 'No stopped worker worktrees to publish', detail: 'Commit the worker’s changes and stop its process first. A finished turn can still leave the process running.' });
    const choice = await dialog.showMessageBox(win, { message: 'Publish committed work for device sync', detail: 'Only clean, stopped worker worktrees can be published. Uncommitted work stays on the host.', buttons: ['Cancel', ...workers.map((w) => `${w.name} · ${w.id}`)], defaultId: 0, cancelId: 0 });
    if (!choice.response) return;
    await json('/api/sync/artifacts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workerId: workers[choice.response - 1].id }) });
    await synchronize();
  } catch (error) {
    await dialog.showMessageBox(win, { type: 'warning', message: 'Work was not published', detail: error.message });
  }
}

/* ---------- menu ---------- */
function menu() {
  const local = !!localSession;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      {
        label: 'Empire',
        submenu: [
          { id: 'run-local', label: local ? 'Running on this computer' : 'Run on this computer…', enabled: !local, click: () => void runOnThisComputer() },
          { id: 'provider-keys', label: 'Provider keys for this computer…', enabled: local, click: showCredentials },
          { type: 'separator' },
          { id: 'change-setup', label: 'Change setup…', click: () => void changeSetup() },
          { type: 'separator' },
          ...(process.platform === 'darwin' ? [] : [{ role: 'quit' }]),
        ],
      },
      {
        label: 'Sync',
        submenu: [
          { label: 'Configure laptop synchronization…', click: () => void configureSync() },
          { label: 'Synchronize published work', click: () => void synchronize() },
          { label: 'Publish stopped worker work…', click: () => void publish() },
          { label: 'Open sync inbox', click: async () => { const c = readConfig(); if (c.repo) await shell.openPath(syncEngine.syncDirectory(c.repo)); } },
        ],
      },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
      {
        label: 'Help',
        submenu: [
          {
            label: 'Where my Empire runs',
            click: () =>
              dialog.showMessageBox(win, {
                message: 'Where your Empire runs',
                detail:
                  'Cloud: your Empire lives in a private repository in your GitHub and keeps working when this app is closed.\n\n' +
                  'Your own server: full capabilities, running on hardware you control, also while this app is closed.\n\n' +
                  'This computer: full capabilities, but only while this app is open. Local workers stop when you quit.',
              }),
          },
        ],
      },
    ]),
  );
}

/* ---------- the game window ---------- */
async function reloadGame() {
  if (!localSession && policy.shouldResumeLocal(readConfig())) await resumeLocal();
  menu();
  if (win && !win.isDestroyed()) await win.loadURL(GAME_URL).catch(() => {});
}

function createGameWindow() {
  const ses = session.fromPartition(PARTITION);
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 640, minHeight: 400, show: false, title: 'Agent Empire', backgroundColor: BACKGROUND, fullscreenable: true,
    webPreferences: { partition: PARTITION, preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  const wc = win.webContents;
  wc.on('input-event', (_event, input) => {
    if (['mouseDown', 'mouseUp', 'keyDown', 'rawKeyDown', 'keyUp', 'touchStart', 'touchEnd', 'gestureTap'].includes(input.type)) lastGesture = Date.now();
  });
  wc.setWindowOpenHandler(({ url }) => {
    const external = policy.externalUrl(url);
    if (external && policy.gestureAllows(lastGesture, Date.now())) {
      lastGesture = 0;
      void shell.openExternal(external);
    }
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (policy.isAppUrl(url)) return;
    event.preventDefault();
    const external = policy.externalUrl(url);
    if (external && policy.gestureAllows(lastGesture, Date.now())) {
      lastGesture = 0;
      void shell.openExternal(external);
    }
  });
  wc.on('will-redirect', (event, url) => !policy.isAppUrl(url) && event.preventDefault());
  wc.on('will-attach-webview', (event) => event.preventDefault());
  wc.on('render-process-gone', () => setTimeout(() => !win.isDestroyed() && void win.loadURL(GAME_URL), 500));
  win.on('closed', () => {
    clearInterval(syncTimer);
    win = undefined;
  });
  return ses;
}

app.setName('Agent Empire');
const ownsInstance = !squirrelOnly && app.requestSingleInstanceLock();
if (!ownsInstance) {
  if (!squirrelOnly) app.quit();
} else
  app.whenReady().then(async () => {
    syncEngine = await import('./runtime/device-sync.js');
    await setUpUpdates();
    const ses = session.fromPartition(PARTITION);
    // The active installed game bundle, else the one built into the app (always the final fallback).
    ses.protocol.handle(policy.APP_SCHEME, createHandler(() => bundles.servingRoot()));
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    store = createSecureStore(path.join(app.getPath('userData'), 'app-session.enc'), safeStorage);
    vault = createVault(path.join(app.getPath('userData'), 'provider-credentials.enc'), safeStorage);

    ipcMain.on('empire:config', (event) => {
      try {
        event.returnValue = fromGame(event) ? pageConfig() : null;
      } catch (error) {
        console.error('config failed', error);
        event.returnValue = null;
      }
    });
    ipcMain.handle('empire:bridge', async (event, raw) => {
      if (!fromGame(event)) return { ok: false, error: 'Request denied.' };
      const request = policy.parseRequest(raw);
      if (!request) return { ok: false, error: 'Bad request.' };
      if (request.error) return { ok: false, error: request.error };
      try {
        const result = await handleBridge(request);
        return { ok: true, result: result ?? null };
      } catch (error) {
        return { ok: false, error: String(error?.message || 'The app refused the request.').slice(0, 500) };
      }
    });
    const fromDevice = (event) => !!deviceFlow?.window && !deviceFlow.window.isDestroyed() && event.sender === deviceFlow.window.webContents && event.senderFrame?.url === deviceUrl;
    ipcMain.handle('device:info', (event) => (fromDevice(event) && deviceFlow.info ? { userCode: deviceFlow.info.userCode } : null));
    ipcMain.handle('device:copy', (event) => {
      if (!fromDevice(event) || !deviceFlow.info) return false;
      clipboard.writeText(deviceFlow.info.userCode);
      return true;
    });
    ipcMain.handle('device:open', async (event) => {
      if (!fromDevice(event) || !deviceFlow.info) return false;
      // A click in our own code window; the URL was checked to be on github.com.
      await shell.openExternal(deviceFlow.info.verificationUri);
      return true;
    });
    ipcMain.handle('device:cancel', (event) => {
      if (fromDevice(event)) deviceFlow.controller.abort();
    });
    const fromCredentials = (event) => !!credentialsWindow && !credentialsWindow.isDestroyed() && event.sender === credentialsWindow.webContents && event.senderFrame?.url === credentialsUrl;
    ipcMain.handle('keys:state', (event) => {
      if (!fromCredentials(event)) return { error: 'Request denied.' };
      try {
        return { ...vault.status(), keys: vault.names() };
      } catch (error) {
        return { error: error.message };
      }
    });
    ipcMain.handle('keys:save', (event, value) => {
      if (!fromCredentials(event) || !localSession) return { error: 'Provider keys are used only by the Empire on this computer.' };
      try {
        // FREE-01: a free hosted key is saved only with the data-use terms confirmed on this page (FREE_PLAN decision).
        const { acceptedHostedTerms, ...keys } = value && typeof value === 'object' ? value : {};
        if (HOSTED.some((k) => typeof keys[k] === 'string' && keys[k].trim()) && acceptedHostedTerms !== true)
          return { error: 'Read and confirm the free hosted providers’ data-use terms before saving their keys.' };
        vault.save(keys);
        return { message: 'Saved securely on this computer. No task was started.' };
      } catch (error) {
        return { error: error.message };
      }
    });

    migrateFromLauncher();
    createGameWindow();
    armTrial(); // a bundle switched at this launch is on trial until the page reports booting
    await reloadGame();
    startSyncTimer();
    app.on('activate', () => {
      if (!win) {
        createGameWindow();
        void reloadGame();
      }
    });
  });

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || !localHost?.hasLocalWorkers()) return;
  const choice = dialog.showMessageBoxSync({ type: 'warning', buttons: ['Keep the app open', 'Quit and stop local workers'], defaultId: 0, cancelId: 0, message: 'Local workers are still running', detail: 'The Empire on this computer runs only while the app is open. Quitting stops its workers.' });
  if (choice !== 1) return event.preventDefault();
  quitting = true;
});
app.on('will-quit', () => {
  deviceFlow?.controller.abort();
  localHost?.shutdown();
  localHost = undefined;
});
app.on('window-all-closed', () => app.quit());
