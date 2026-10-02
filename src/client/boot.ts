/**
 * Page entry. Decides between the game and the first-launch setup before any heavy code loads:
 * the game bundle (main.ts, three.js, models) is imported only once the Empire has somewhere to run.
 *
 * Cloud mode: with a stored GitHub sign-in the game opens straight away and shows the Empire from its state
 * repository (CLOUD-04). Without one (a browser after the page closed) the player signs in again first.
 */
import { appConfig, setSessionConfig } from './endpoint';
import { dismissKeyboard } from './keyboard';
import { native, shellInfo } from './native';
import { decideLaunch, probeOwnOrigin, type LaunchDecision } from './setup/launch';
import { reportBootOk } from './update/boot-ok';

const splash = document.getElementById('splash');

function startGame() {
  if (splash) splash.style.display = '';
  // The game module evaluated: this bundle boots (the shell keeps it instead of rolling back).
  void import('./main').then(reportBootOk, (error) => console.error('The game failed to start', error));
}

/** Hands the cloud session to the game, then loads it. The token stays in memory (and the app's secure storage). */
async function startCloudGame(session: { token: string; repo: string; login?: string }) {
  const { setCloudSession, parseRepo } = await import('./cloud/session');
  const repo = parseRepo(session.repo);
  if (!repo) throw new Error('Invalid state repository');
  setCloudSession({ repo, token: session.token, ...(session.login ? { login: session.login } : {}) });
  document.documentElement.dataset.boot = 'loading';
  startGame();
}

async function showSetup(decision: Exclude<LaunchDecision, { kind: 'game' } | { kind: 'redirect' }>) {
  if (splash) splash.style.display = 'none';
  document.documentElement.dataset.boot = 'setup';
  const [{ mountSetup, mountCloudUnlock }, { initialState }, { githubClientId }] = await Promise.all([
    import('./setup/view'),
    import('./setup/model'),
    import('./setup/config'),
  ]);
  const bridge = native();
  const shell = shellInfo();
  // Forgets the cloud choice on this device only; the state repository on GitHub is left untouched.
  const changeSetup = async () => {
    const { forgetSavedSnapshots } = await import('./cloud/session');
    forgetSavedSnapshots();
    await Promise.allSettled([bridge.secureDelete('mode'), bridge.secureDelete('state.repo'), bridge.secureDelete('github.token'), bridge.secureDelete('github.login')]);
    location.reload();
  };

  if (decision.kind === 'cloud') {
    reportBootOk();
    const root = mountCloudUnlock({
      repo: decision.repo,
      native: bridge,
      clientId: githubClientId(),
      onChangeSetup: changeSetup,
      onUnlocked: async (session) => {
        dismissKeyboard();
        await startCloudGame(session);
        root.remove();
      },
    });
    return;
  }

  reportBootOk();
  const view = mountSetup(initialState({ step: decision.step, mode: decision.mode, notice: decision.notice, address: decision.address }), {
    native: bridge,
    shell,
    clientId: githubClientId(),
    onServerSession: async (session) => {
      dismissKeyboard();
      setSessionConfig({ host: session.host, token: session.token, deviceId: session.deviceId, platform: shell?.platform ?? 'ios' });
      document.documentElement.dataset.boot = 'loading';
      startGame();
      await view.leave();
    },
    onWebServer: (host) => location.assign(host === location.origin ? '/login' : `${host}/login`),
    onCloudCreated: async (repo, github) => {
      dismissKeyboard();
      await startCloudGame({ token: github.token, login: github.login, repo: `${repo.owner}/${repo.name}` });
      await view.leave();
    },
  });
}

async function boot() {
  const bridge = native();
  const decision = await decideLaunch({
    shell: shellInfo(),
    hasSession: appConfig() !== null,
    get: (key) => bridge.secureGet(key),
    probe: () => probeOwnOrigin(),
    origin: location.origin,
  });
  if (decision.kind === 'game') return startGame();
  if (decision.kind === 'redirect') return location.replace(decision.url);
  if (decision.kind === 'cloud' && decision.repo) {
    // Relaunch: a stored sign-in opens the Empire at once (the game shows the last saved snapshot, then GitHub's).
    const token = await bridge.secureGet('github.token').catch(() => null);
    if (token) return startCloudGame({ token, repo: decision.repo, login: (await bridge.secureGet('github.login').catch(() => null)) ?? undefined }).catch(() => showSetup(decision));
  }
  await showSetup(decision);
}

boot().catch((err) => {
  // Never strand the player on a blank screen. A browser falls back to the game (it has its own connection UI);
  // an app without a session can only go on through the setup.
  console.error('Launch decision failed', err);
  if (shellInfo() && !appConfig()) void showSetup({ kind: 'setup', step: 'welcome' }).catch(() => {});
  else startGame();
});
