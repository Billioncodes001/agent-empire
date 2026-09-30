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
 * app.signedOut {reason}, app.openExternal {url}. The answer arrives asynchronously as
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
    }

    private final Host host;
    private final SecureStore store;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private GitHubDeviceFlow flow;

    NativeBridge(Host host, SecureStore store) {
        this.host = host;
        this.store = store;
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
                if (!(value instanceof String) || !BridgePolicy.isValue((String) value)) { reject(id, "Value must be a string of at most 8192 characters"); return; }
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
            default:
                reject(id, "Unknown method");
        }
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
