package com.agentempire.mobile;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The single native bridge object (docs/team/CLOUD_MODE_PLAN.md, "Native bridge contract"), exposed to the page as
 * window.empireAndroid with exactly one method:
 *
 *   empireAndroid.postMessage(JSON.stringify({id, method, params}))
 *
 * Methods: secure.get {key}, secure.set {key, value}, secure.delete {key}, github.deviceFlow {clientId, scopes},
 * app.signedOut {reason}, app.openExternal {url}, and the in-app update calls (REL-04; src/client/update/bridge.ts):
 * update.fetch {url, etag?}, update.installGame {url, sha256, version}, update.activate, update.bootOk,
 * update.nativeInfo, update.openNative {version, url?, sha256?, play?}. The answer arrives asynchronously as
 * window.__empireNative.resolve(id, result) or window.__empireNative.reject(id, message).
 * The legacy APP-02 message {type: 'signedOut', reason} (no id, no answer) is also accepted.
 *
 * Every call is checked on the UI thread: the WebView's current top-level URL must be on
 * https://appassets.androidplatform.net, or the call is dropped without an answer. Answers are only delivered while
 * that is still true. Secure storage work runs on a background thread.
 */
final class NativeBridge {
    static final String NAME = "empireAndroid";
    private static final String TAG = "AgentEmpire";

    /** What the bridge needs from the activity. All methods are called on the UI thread. */
    interface Host {
        /** WebView.getUrl() of the top-level document. */
        String currentUrl();
        /** Runs JavaScript in the page (evaluateJavascript). */
        void evaluate(String script);
        /** True (once) if the player touched or pressed a key within the gesture window. */
        boolean consumeGesture();
        /** Opens an already validated https URL in the system browser. */
        boolean openExternal(String url);
        /** Starts the native GitHub device flow. */
        GitHubDeviceFlow deviceFlow(String clientId, String scope, GitHubDeviceFlow.Callback callback);
        /** Session keys were cleared; reload the game without them. */
        void signedOut(String reason);
        /** In-app updates: the bundle store and installer. */
        GameUpdater updater();
        /** A pending bundle became the trial: reload the game into it and start the 20 s rollback timer. */
        void restartGame();
        /** The page booted: stop the rollback timer. */
        void bootReported();
    }

    private final Host host;
    private final SecureStore store;
    private final boolean debuggable;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    /** Update downloads take minutes: their own threads, so secure storage never waits behind them. */
    private final ExecutorService updateIo = Executors.newFixedThreadPool(2);
    private GitHubDeviceFlow flow;

    NativeBridge(Host host, SecureStore store, boolean debuggable) {
        this.host = host;
        this.store = store;
        this.debuggable = debuggable;
    }

    /** Called by the WebView on its JavaBridge thread, from any frame; everything is re-checked on the UI thread. */
    @JavascriptInterface
    public void postMessage(String message) {
        if (message == null || message.length() > BridgePolicy.MAX_MESSAGE_LENGTH) return;
        main.post(() -> handle(message));
    }

    void destroy() {
        if (flow != null) flow.cancel();
        io.shutdown();
        updateIo.shutdown();
    }

    private void handle(String message) {
        if (!AssetPolicy.isAppOrigin(host.currentUrl())) {
            Log.w(TAG, "Bridge call dropped: the page is not the bundled game");
            return;
        }
        JSONObject msg;
        try {
            msg = new JSONObject(message);
        } catch (Exception malformed) {
            return;
        }
        if (!msg.has("id") && "signedOut".equals(msg.optString("type"))) { // APP-02 client, fire-and-forget
            signOut(null, msg.optString("reason", "unauthorized"));
            return;
        }
        Object rawId = msg.opt("id");
        String idText = rawId instanceof String || rawId instanceof Number ? String.valueOf(rawId) : null;
        if (!BridgePolicy.isRequestId(idText)) return;
        // The id goes back exactly as sent: a number stays a number, a string stays a string (as a JSON literal).
        String id = rawId instanceof Number ? idText : JSONObject.quote(idText);
        String method = msg.optString("method", "");
        JSONObject params = msg.optJSONObject("params");
        if (params == null) params = new JSONObject();
        if (!BridgePolicy.isMethod(method)) {
            reject(id, "Unknown method");
            return;
        }
        switch (method) {
            case "secure.get": {
                String key = params.optString("key", null);
                if (!BridgePolicy.isKey(key)) { reject(id, "Key not allowed"); return; }
                io.execute(() -> {
                    String value = store.get(key);
                    main.post(() -> resolve(id, value == null ? "null" : JSONObject.quote(value)));
                });
                return;
            }
            case "secure.set": {
                String key = params.optString("key", null);
                Object value = params.opt("value");
                if (!BridgePolicy.isKey(key)) { reject(id, "Key not allowed"); return; }
                if (!(value instanceof String)) { reject(id, "That value can't be stored."); return; }
                // Same per-key rules as iOS (mode, exact server origin, token/id/login/repo shapes).
                String invalid = BridgePolicy.invalidValue(key, (String) value, debuggable);
                if (invalid != null) { reject(id, invalid); return; }
                io.execute(() -> {
                    try {
                        store.set(key, (String) value);
                        main.post(() -> resolve(id, "true"));
                    } catch (Exception error) {
                        Log.w(TAG, "secure.set failed: " + error.getClass().getSimpleName());
                        main.post(() -> reject(id, "Secure storage is unavailable"));
                    }
                });
                return;
            }
            case "secure.delete": {
                String key = params.optString("key", null);
                if (!BridgePolicy.isKey(key)) { reject(id, "Key not allowed"); return; }
                io.execute(() -> {
                    store.delete(key);
                    main.post(() -> resolve(id, "true"));
                });
                return;
            }
            case "github.deviceFlow": {
                String clientId = params.optString("clientId", null);
                JSONArray rawScopes = params.optJSONArray("scopes");
                List<String> scopes = new ArrayList<>();
                if (rawScopes != null) for (int i = 0; i < rawScopes.length(); i++) scopes.add(rawScopes.opt(i) instanceof String ? rawScopes.optString(i) : null);
                String scope = BridgePolicy.scopes(scopes);
                if (!BridgePolicy.isClientId(clientId) || scope == null) { reject(id, "invalid_request: clientId or scopes are malformed"); return; }
                if (flow != null) { reject(id, "invalid_request: a GitHub sign-in is already in progress"); return; }
                flow = host.deviceFlow(clientId, scope, new GitHubDeviceFlow.Callback() {
                    @Override public void success(String token, String login) {
                        flow = null;
                        try {
                            JSONObject result = new JSONObject().put("token", token).put("login", login == null ? JSONObject.NULL : login);
                            resolve(id, result.toString());
                        } catch (Exception impossible) {
                            reject(id, "github_error: could not encode the result");
                        }
                    }
                    @Override public void failure(String code, String message) {
                        flow = null;
                        reject(id, code + ": " + message);
                    }
                });
                flow.start();
                return;
            }
            case "app.signedOut":
                signOut(id, params.optString("reason", "user"));
                return;
            case "app.openExternal": {
                String url = BridgePolicy.externalUrl(params.optString("url", null));
                if (url == null) { reject(id, "Only https links can be opened"); return; }
                if (!host.consumeGesture()) { reject(id, "Opening a link needs a tap first"); return; }
                if (host.openExternal(url)) resolve(id, "true");
                else reject(id, "No browser is available");
                return;
            }
            case "update.fetch": {
                String url = params.optString("url", null);
                String etag = params.optString("etag", null);
                if (!UpdatePolicy.isFetchUrl(url)) { reject(id, "That address is not an Agent Empire release."); return; }
                final String tag = UpdatePolicy.isEtag(etag) ? etag : null;
                updateIo.execute(() -> {
                    try {
                        GameUpdater.Fetched r = host.updater().fetch(url, tag, UpdatePolicy.MAX_TEXT_BYTES, null);
                        JSONObject out = new JSONObject().put("status", r.status).put("body", new String(r.body, java.nio.charset.StandardCharsets.UTF_8))
                            .put("etag", r.etag == null ? JSONObject.NULL : r.etag);
                        main.post(() -> resolve(id, out.toString()));
                    } catch (Exception error) {
                        main.post(() -> reject(id, message(error, "GitHub could not be reached.")));
                    }
                });
                return;
            }
            case "update.installGame": {
                String url = params.optString("url", null), sha = params.optString("sha256", null), version = params.optString("version", null);
                if (!UpdatePolicy.isTaggedAsset(url)) { reject(id, "That update is not an Agent Empire release."); return; }
                if (!UpdatePolicy.isSha256(sha)) { reject(id, "Malformed sha256."); return; }
                if (!UpdatePolicy.isSemver(version)) { reject(id, "Malformed version."); return; }
                updateIo.execute(() -> {
                    try {
                        String installed = host.updater().installGame(url, sha, version);
                        main.post(() -> resolve(id, "{\"version\":" + JSONObject.quote(installed) + "}"));
                    } catch (Exception error) {
                        main.post(() -> reject(id, message(error, "The update could not be installed.")));
                    }
                });
                return;
            }
            case "update.activate":
                if (!host.updater().activate(System.currentTimeMillis())) { reject(id, "No update is waiting."); return; }
                resolve(id, "true");
                main.postDelayed(host::restartGame, 50);
                return;
            case "update.bootOk":
                host.updater().bootOk();
                host.bootReported();
                resolve(id, "true");
                return;
            case "update.nativeInfo": {
                GameUpdater u = host.updater();
                try {
                    JSONObject out = new JSONObject().put("platform", "android").put("shellVersion", u.shellVersion())
                        .put("installedGame", nullable(u.installedGame())).put("builtinGame", nullable(u.builtinVersion())).put("pendingGame", nullable(u.pendingGame()))
                        .put("canInstallGame", true).put("canAutoUpdate", false).put("installSource", u.installSource());
                    String back = u.takeRolledBack();
                    if (back != null) out.put("rolledBack", back);
                    resolve(id, out.toString());
                } catch (Exception impossible) {
                    reject(id, "The app could not report its version.");
                }
                return;
            }
            case "update.openNative": {
                String version = params.optString("version", null), url = params.optString("url", null), sha = params.optString("sha256", null), play = params.optString("play", null);
                if (!UpdatePolicy.isSemver(version)) { reject(id, "Malformed version."); return; }
                boolean sideload = !"play".equals(host.updater().installSource());
                if (sideload && UpdatePolicy.isTaggedAsset(url) && UpdatePolicy.isSha256(sha)) {
                    updateIo.execute(() -> {
                        try {
                            String action = host.updater().installApk(url, sha);
                            main.post(() -> resolve(id, "{\"action\":" + JSONObject.quote(action) + "}"));
                        } catch (Exception error) {
                            main.post(() -> reject(id, message(error, "The app update could not be downloaded.")));
                        }
                    });
                    return;
                }
                if (play != null && UpdatePolicy.isPlayUrl(play)) {
                    if (!host.consumeGesture()) { reject(id, "Opening Google Play needs a tap first"); return; }
                    if (host.openExternal(play)) resolve(id, "{\"action\":\"store\"}");
                    else reject(id, "Google Play is not available");
                    return;
                }
                reject(id, "This update has nothing this app can open.");
                return;
            }
            default:
                reject(id, "Unknown method");
        }
    }

    private static Object nullable(String value) { return value == null ? JSONObject.NULL : value; }

    private static String message(Exception error, String fallback) {
        String m = error.getMessage();
        return m == null || m.isEmpty() ? fallback : m.length() > 300 ? m.substring(0, 300) : m;
    }

    private void signOut(String id, String reason) {
        if (flow != null) flow.cancel();
        io.execute(() -> {
            store.clearSession();
            main.post(() -> {
                if (id != null) resolve(id, "true");
                host.signedOut(reason);
            });
        });
    }

    private void resolve(String id, String resultJson) {
        deliver("resolve", id, resultJson);
    }

    private void reject(String id, String message) {
        deliver("reject", id, JSONObject.quote(message));
    }

    /** idJson is the request id as a JSON literal (validated by BridgePolicy.isRequestId). */
    private void deliver(String kind, String idJson, String payloadJson) {
        // Never hand a result (possibly a token) to a document that is not the bundled game.
        if (!AssetPolicy.isAppOrigin(host.currentUrl())) return;
        host.evaluate("window.__empireNative&&window.__empireNative." + kind + "(" + idJson + "," + payloadJson + ")");
    }
}
