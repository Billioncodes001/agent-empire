/**
 * Game window preload (sandboxed, context-isolated). Exposes exactly two things, and only to the bundled game's
 * main frame at empire-app://game:
 *   window.AGENT_EMPIRE_APP  the shell config, set before any page script runs
 *   window.empireDesktop     {postMessage(request)}: the native bridge transport (src/client/native.ts)
 * Answers go back through the page's own window.__empireNative.resolve/reject(id, …). The main process re-checks
 * the sender and validates every request (bridge-policy.cjs); this file holds no policy of its own.
 */
const { contextBridge, ipcRenderer, webFrame } = require('electron');

const APP_ORIGIN = 'empire-app://game';
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;

function answer(id, ok, value) {
  const fn = ok ? 'resolve' : 'reject';
  const payload = JSON.stringify(value === undefined ? null : value);
  // Runs in the page's world, where the bridge receiver lives. Both values are JSON literals, never code.
  void webFrame.executeJavaScript(`void (window.__empireNative && window.__empireNative.${fn}(${JSON.stringify(id)}, ${payload}))`).catch(() => {});
}

if (location.origin === APP_ORIGIN && window.top === window) {
  let config = null;
  try {
    config = ipcRenderer.sendSync('empire:config');
  } catch {}
  if (config && typeof config === 'object') contextBridge.exposeInMainWorld('AGENT_EMPIRE_APP', config);
  contextBridge.exposeInMainWorld('empireDesktop', {
    postMessage(request) {
      const id = request && typeof request === 'object' && typeof request.id === 'string' && ID.test(request.id) ? request.id : null;
      if (!id) return;
      const message = { id, method: String(request.method ?? ''), params: request.params && typeof request.params === 'object' ? request.params : {} };
      ipcRenderer.invoke('empire:bridge', message).then(
        (reply) => (reply && reply.ok ? answer(id, true, reply.result) : answer(id, false, String(reply?.error ?? 'The app refused the request.'))),
        () => answer(id, false, 'The app could not complete the request.'),
      );
    },
  });
}
