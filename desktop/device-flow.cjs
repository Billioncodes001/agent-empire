/**
 * GitHub OAuth device flow, run in the main process (GitHub's token endpoints send no CORS headers). Takes the
 * public client id and the already-checked scope string from the page; persists nothing. Errors are
 * "<code>: <text>" with code one of cancelled, expired_token, access_denied, network, github_error,
 * invalid_request (the same codes as the Android shell).
 */
const { isVerificationUrl } = require('./bridge-policy.cjs');

class DeviceFlowError extends Error {
  constructor(code, text) {
    super(`${code}: ${text}`);
    this.code = code;
  }
}

const USER_CODE = /^[A-Z0-9-]{4,16}$/;
const TOKEN = /^[A-Za-z0-9_.-]{10,512}$/;

/**
 * @param {object} o
 * @param {string} o.clientId
 * @param {string} o.scope            space-separated, checked by bridge-policy scopes()
 * @param {(code:{userCode:string, verificationUri:string, expiresIn:number}) => void} o.onCode
 * @param {AbortSignal} o.signal      aborted when the player cancels
 * @param {typeof fetch} o.fetch
 * @param {(ms:number, signal:AbortSignal) => Promise<void>} [o.sleep]
 * @param {string} [o.githubOrigin]   https://github.com
 * @param {string} [o.apiOrigin]      https://api.github.com
 */
async function runDeviceFlow({ clientId, scope, onCode, signal, fetch, sleep = abortableSleep, now = Date.now, githubOrigin = 'https://github.com', apiOrigin = 'https://api.github.com' }) {
  const post = async (url, body) => {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
        redirect: 'error',
        signal,
      });
    } catch {
      if (signal.aborted) throw new DeviceFlowError('cancelled', 'GitHub sign-in was cancelled.');
      throw new DeviceFlowError('network', 'GitHub could not be reached. Check your connection.');
    }
    const json = await res.json().catch(() => null);
    if (!json || typeof json !== 'object') throw new DeviceFlowError('github_error', `GitHub answered unexpectedly (${res.status}).`);
    return { status: res.status, json };
  };

  const start = await post(`${githubOrigin}/login/device/code`, { client_id: clientId, scope });
  const d = start.json;
  if (d.error) throw new DeviceFlowError(d.error === 'unauthorized_client' || d.error === 'device_flow_disabled' ? 'invalid_request' : 'github_error', String(d.error_description || d.error).slice(0, 200));
  if (typeof d.device_code !== 'string' || !d.device_code || typeof d.user_code !== 'string' || !USER_CODE.test(d.user_code) || !isVerificationUrl(d.verification_uri, githubOrigin))
    throw new DeviceFlowError('github_error', 'GitHub sent an unexpected sign-in code.');
  const expiresIn = Number.isFinite(d.expires_in) && d.expires_in > 0 ? Math.min(d.expires_in, 1800) : 900;
  let interval = Number.isFinite(d.interval) && d.interval > 0 ? Math.min(d.interval, 60) : 5;
  const deadline = now() + expiresIn * 1000;
  onCode({ userCode: d.user_code, verificationUri: d.verification_uri, expiresIn });

  for (;;) {
    await sleep(interval * 1000, signal).catch(() => {
      throw new DeviceFlowError('cancelled', 'GitHub sign-in was cancelled.');
    });
    if (signal.aborted) throw new DeviceFlowError('cancelled', 'GitHub sign-in was cancelled.');
    if (now() > deadline) throw new DeviceFlowError('expired_token', 'The GitHub code expired. Start sign-in again.');
    const poll = await post(`${githubOrigin}/login/oauth/access_token`, { client_id: clientId, device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    const r = poll.json;
    if (typeof r.access_token === 'string') {
      if (!TOKEN.test(r.access_token)) throw new DeviceFlowError('github_error', 'GitHub sent an unexpected token.');
      return { token: r.access_token, login: await fetchLogin(r.access_token) };
    }
    switch (r.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        interval = Number.isFinite(r.interval) && r.interval > interval ? Math.min(r.interval, 60) : interval + 5;
        continue;
      case 'expired_token':
        throw new DeviceFlowError('expired_token', 'The GitHub code expired. Start sign-in again.');
      case 'access_denied':
        throw new DeviceFlowError('access_denied', 'GitHub sign-in was declined.');
      default:
        throw new DeviceFlowError('github_error', String(r.error_description || r.error || `GitHub answered ${poll.status}.`).slice(0, 200));
    }
  }

  async function fetchLogin(token) {
    try {
      const res = await fetch(`${apiOrigin}/user`, { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` }, redirect: 'error', signal });
      const user = res.ok ? await res.json() : null;
      return typeof user?.login === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(user.login) ? user.login : null;
    } catch {
      return null;
    }
  }
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', stop, { once: true });
  });
}

module.exports = { runDeviceFlow, DeviceFlowError };
