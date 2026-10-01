/**
 * Page entry. Decides between the game and the first-launch setup before any heavy code loads:
 * the game bundle (main.ts, three.js, models) is imported only once the Empire has somewhere to run.
 */
import { appConfig, setSessionConfig } from './endpoint';
import { dismissKeyboard } from './keyboard';
import { native, shellInfo } from './native';
import { decideLaunch, probeOwnOrigin, type LaunchDecision } from './setup/launch';

const splash = document.getElementById('splash');

function startGame() {
  if (splash) splash.style.display = '';
  void import('./main');
}

async function showSetup(decision: Exclude<LaunchDecision, { kind: 'game' } | { kind: 'redirect' }>) {
  if (splash) splash.style.display = 'none';
  document.documentElement.dataset.boot = 'setup';
  const [{ mountSetup, mountCloudPending }, { initialState }, { githubClientId }] = await Promise.all([
    import('./setup/view'),
    import('./setup/model'),
    import('./setup/config'),
  ]);
  const bridge = native();
  const shell = shellInfo();
  // Forgets the cloud choice on this device only; the state repository on GitHub is left untouched.
  const changeSetup = async () => {
    await Promise.allSettled([bridge.secureDelete('mode'), bridge.secureDelete('state.repo')]);
    location.reload();
  };

  if (decision.kind === 'cloud') {
    mountCloudPending({ repo: decision.repo, native: bridge, onChangeSetup: changeSetup });
    return;
  }

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
    onCloudCreated: async (repo) => {
      await view.leave();
      mountCloudPending({ repo: `${repo.owner}/${repo.name}`, native: bridge, onChangeSetup: changeSetup });
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
  await showSetup(decision);
}

boot().catch((err) => {
  // Never strand the player on a blank screen. A browser falls back to the game (it has its own connection UI);
  // an app without a session can only go on through the setup.
  console.error('Launch decision failed', err);
  if (shellInfo() && !appConfig()) void showSetup({ kind: 'setup', step: 'welcome' }).catch(() => {});
  else startGame();
});
