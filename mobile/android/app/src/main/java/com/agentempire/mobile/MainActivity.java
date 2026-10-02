package com.agentempire.mobile;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Typeface;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.HttpAuthHandler;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The Agent Empire game app: one full-screen, immersive, landscape Activity hosting the bundled game.
 *
 * - The game is the built web client copied into the APK (assets/game) and served by GameAssets at
 *   https://appassets.androidplatform.net/. Only that origin can load in the WebView; other main-frame navigations are
 *   blocked, and a link the player tapped opens in the system browser (https only).
 * - window.AGENT_EMPIRE_APP = {platform: 'android', ...} is defined by a script injected as the first element of
 *   <head>, so it exists before any page script runs.
 * - NativeBridge is the only native capability exposed to the page.
 * - Launch: the theme's window background (and the Android 12+ system splash) is brand ink with the tower mark; a
 *   native overlay with the same mark stays until the page has painted, so no white frame is ever shown.
 * - Hardware Back opens (or closes) the in-game menu instead of leaving the game.
 */
public final class MainActivity extends Activity implements NativeBridge.Host {
    private static final String TAG = "AgentEmpire";
    private static final String VERSION = "0.3.0";
    /** The client's menu key (src/client/ui/game-menu.ts MENU_KEY). */
    private static final String MENU_KEY_SCRIPT =
        "(function(){var o={code:'Backquote',key:'`',bubbles:true,cancelable:true};"
            + "window.dispatchEvent(new KeyboardEvent('keydown',o));window.dispatchEvent(new KeyboardEvent('keyup',o));})()";

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private boolean debuggable;
    private FrameLayout root;
    private WebView web;
    private View splash;
    private boolean revealed;
    private long lastGestureAt;
    private SecureStore store;
    private NativeBridge bridge;
    private GameAssets gameAssets;
    /** In-app game updates (REL-04): the bundle store, its 20 s rollback timer and the APK installer. */
    private GameUpdater updater;
    private final Runnable trialCheck = this::checkTrial;
    private OnBackInvokedCallback backCallback;
    /** Debug builds only: a local fake GitHub for device-flow tests (see handleDebugIntent). */
    private volatile String debugGithubBase;
    /** Why the last session ended; handed to the page once (config "signedOut") so the sign-in step can say why. */
    private volatile String signedOutReason;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        store = new SecureStore(this);
        updater = new GameUpdater(this, debuggable);
        // A pending bundle switches in now (a trial until the page reports booting); an unfinished trial rolls back.
        updater.launch(System.currentTimeMillis());
        gameAssets = new GameAssets(getAssets(), this::configScript, () -> updater.activeRoot());
        Window window = getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams attrs = window.getAttributes();
            attrs.layoutInDisplayCutoutMode = Build.VERSION.SDK_INT >= 30
                ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(attrs);
        }
        if (Build.VERSION.SDK_INT >= 30) window.setDecorFitsSystemWindows(false);

        root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.brand_ink));
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 30) {
            // With setDecorFitsSystemWindows(false), adjustResize no longer shrinks the window for the on-screen keyboard,
            // which then covers the focused field. Lift the game above the keyboard instead: the page sees a shorter
            // viewport and fits its setup and dialogs (with the focused field and primary action) into it.
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                int ime = insets.getInsets(WindowInsets.Type.ime()).bottom;
                if (view.getPaddingBottom() != ime) {
                    view.setPadding(0, 0, 0, ime);
                    // Re-dispatch once the new size is laid out, so the WebView re-reads the display cutout for
                    // env(safe-area-inset-*) against its final frame (it otherwise drops the cutout inset).
                    view.post(view::requestApplyInsets);
                }
                return insets;
            });
        }
        createWebView();
        splash = buildSplash();
        root.addView(splash, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        hideSystemBars();

        if (Build.VERSION.SDK_INT >= 33) {
            backCallback = this::onGameBack;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback);
        }
        handleInstallStatus(getIntent());
        if (debuggable && handleDebugIntent(getIntent())) return; // it loads the game when done
        loadGame();
    }

    // ---- WebView -------------------------------------------------------------------------------------------------

    @SuppressWarnings("SetJavaScriptEnabled")
    private void createWebView() {
        WebView.setWebContentsDebuggingEnabled(debuggable);
        web = new WebView(this);
        web.setBackgroundColor(getColor(R.color.brand_ink));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setGeolocationEnabled(false);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setTextZoom(100); // the HUD is laid out by the game; system font scale is honoured by its own settings
        settings.setMediaPlaybackRequiresUserGesture(false); // game audio after the first tap
        settings.setSaveFormData(false);
        // Release: an https page may not load http. Debug: allows the local http:// test server (10.0.2.2) only,
        // because the network security config refuses cleartext to every other host.
        settings.setMixedContentMode(debuggable ? WebSettings.MIXED_CONTENT_ALWAYS_ALLOW : WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptCookie(false); // the app authenticates with bearer tokens only
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        // No service workers: the game ships inside the APK (the client skips registration in app mode anyway), and a
        // worker's own fetches would bypass the asset loader and its origin rules.
        ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) { return GameAssets.text(403, "Forbidden"); }
        });

        bridge = new NativeBridge(this, store, debuggable);
        web.addJavascriptInterface(bridge, NativeBridge.NAME);
        web.setWebViewClient(new GameClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, android.os.Message result) { return false; }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) { return false; }
            @Override public boolean onConsoleMessage(ConsoleMessage message) {
                if (debuggable) Log.d(TAG, "console " + message.messageLevel() + ": " + message.message() + " (" + message.sourceId() + ":" + message.lineNumber() + ")");
                return true;
            }
        });
        web.setDownloadListener((url, agent, disposition, mime, length) -> Log.w(TAG, "Download blocked"));
        root.addView(web, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void loadGame() {
        armTrial();
        if (web != null) web.loadUrl(AssetPolicy.START_URL);
        // If the page never reports a first paint (for example a broken bundle), do not keep the overlay forever.
        main.postDelayed(this::reveal, 12000);
    }

    private final class GameClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            if (AssetPolicy.isAppOrigin(url)) return gameAssets.handle(request);
            // POST navigations and redirects do not always reach shouldOverrideUrlLoading; the main frame never leaves the game.
            if (request.isForMainFrame()) return GameAssets.text(403, "Forbidden");
            // Release builds never fetch cleartext, even if the network security config were bypassed.
            if (!debuggable && !"https".equalsIgnoreCase(request.getUrl().getScheme())) return GameAssets.text(403, "Forbidden");
            return null; // API calls to the Empire server, GitHub API, etc. go to the network as normal CORS requests
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            if (AssetPolicy.isAppOrigin(url) && request.isForMainFrame()) return false;
            // A link the player tapped (e.g. "Open on GitHub") goes to the system browser, https only. Nothing else navigates.
            String external = BridgePolicy.externalUrl(url);
            if (external != null && request.hasGesture()) openExternal(external);
            else Log.w(TAG, "Navigation blocked");
            return true;
        }

        @Override
        public void onPageCommitVisible(WebView view, String url) {
            if (AssetPolicy.isAppOrigin(url)) reveal();
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (AssetPolicy.isAppOrigin(url)) reveal();
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel(); // no certificate exceptions, ever
        }

        @Override
        public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler, String host, String realm) {
            handler.cancel();
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // The renderer crashed or was killed for memory: rebuild the WebView and reload the game instead of dying.
            Log.w(TAG, "WebView renderer gone (crash=" + detail.didCrash() + "); reloading the game");
            if (view == web) {
                root.removeView(web);
                web.destroy();
                web = null;
                if (bridge != null) bridge.destroy();
                createWebView();
                loadGame();
            }
            return true;
        }
    }

    /** Body of /__agent-empire/app-config.js. Runs on a WebView IO thread, so it may read secure storage. */
    private String configScript() {
        JSONObject config = new JSONObject();
        try {
            config.put("platform", "android");
            config.put("appVersion", VERSION);
            config.put("bridge", NativeBridge.NAME);
            // Same fields as the iOS shell: device name, stored mode, a valid server session (APP-02 compatible: the
            // current client talks to that server with its device token), and a one-shot sign-out reason.
            String reason = signedOutReason;
            signedOutReason = null;
            for (java.util.Map.Entry<String, String> field : BridgePolicy.configFields(deviceName(), store.get("mode"), store.get("server.host"),
                store.get("server.token"), store.get("server.deviceId"), reason, debuggable).entrySet()) config.put(field.getKey(), field.getValue());
        } catch (Exception error) {
            Log.w(TAG, "App config incomplete: " + error.getClass().getSimpleName());
        }
        return "window.AGENT_EMPIRE_APP=Object.freeze(" + config + ");\n";
    }

    // ---- In-app updates (REL-04) -----------------------------------------------------------------------------------

    /** While a new bundle is on trial, rolls back if the page hasn't reported booting 20 s after it started. */
    private void armTrial() {
        main.removeCallbacks(trialCheck);
        long remaining = updater.trialRemaining(System.currentTimeMillis());
        if (remaining >= 0) main.postDelayed(trialCheck, remaining + 50);
    }

    private void checkTrial() {
        if (updater.checkTrial(System.currentTimeMillis())) {
            Log.w(TAG, "The updated game did not report booting within 20 s; rolled back");
            if (web != null) web.loadUrl(AssetPolicy.START_URL);
        }
    }

    @Override public GameUpdater updater() { return updater; }

    @Override
    public void restartGame() {
        armTrial();
        if (web != null) web.loadUrl(AssetPolicy.START_URL);
    }

    @Override public void bootReported() { main.removeCallbacks(trialCheck); }

    /** The system installer's answer for an app update (GameUpdater.installApk): show its confirmation. */
    private boolean handleInstallStatus(Intent intent) {
        if (intent == null || !GameUpdater.INSTALL_ACTION.equals(intent.getAction())) return false;
        int status = intent.getIntExtra(android.content.pm.PackageInstaller.EXTRA_STATUS, Integer.MIN_VALUE);
        if (status == android.content.pm.PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = Build.VERSION.SDK_INT >= 33 ? intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class) : legacyIntentExtra(intent);
            if (confirm != null) {
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    startActivity(confirm);
                } catch (ActivityNotFoundException none) {
                    Log.w(TAG, "No installer to confirm the app update");
                }
            }
        } else if (status != android.content.pm.PackageInstaller.STATUS_SUCCESS) {
            Log.w(TAG, "App update not installed: " + intent.getStringExtra(android.content.pm.PackageInstaller.EXTRA_STATUS_MESSAGE));
        }
        return true;
    }

    @SuppressWarnings("deprecation")
    private static Intent legacyIntentExtra(Intent intent) { return intent.getParcelableExtra(Intent.EXTRA_INTENT); }

    // ---- Launch overlay ------------------------------------------------------------------------------------------

    private View buildSplash() {
        LinearLayout overlay = new LinearLayout(this);
        overlay.setOrientation(LinearLayout.VERTICAL);
        overlay.setGravity(Gravity.CENTER);
        overlay.setBackgroundColor(getColor(R.color.brand_ink));
        overlay.setClickable(true); // swallow touches until the game shows
        overlay.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        overlay.setContentDescription("Agent Empire is loading");
        ImageView mark = new ImageView(this);
        mark.setImageResource(R.drawable.ic_launcher_foreground);
        int size = dp(132);
        overlay.addView(mark, new LinearLayout.LayoutParams(size, size));
        TextView title = new TextView(this);
        title.setText("AGENT EMPIRE");
        title.setTextColor(getColor(R.color.brand_text));
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        title.setLetterSpacing(0.32f);
        title.setGravity(Gravity.CENTER);
        overlay.addView(title);
        TextView tag = new TextView(this);
        tag.setText("YOUR AI COMPANY IN A LIVING CITY");
        tag.setTextColor(getColor(R.color.brand_muted));
        tag.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        tag.setLetterSpacing(0.16f);
        tag.setGravity(Gravity.CENTER);
        tag.setPadding(0, dp(6), 0, 0);
        overlay.addView(tag);
        return overlay;
    }

    /** Fades the native overlay into the page's own splash (same colours and mark) once the page has painted. */
    private void reveal() {
        if (revealed || splash == null) return;
        revealed = true;
        View overlay = splash;
        overlay.animate().alpha(0f).setDuration(220).setListener(new AnimatorListenerAdapter() {
            @Override public void onAnimationEnd(Animator animation) {
                root.removeView(overlay);
            }
        });
        splash = null;
    }

    // ---- Immersive landscape -------------------------------------------------------------------------------------

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.systemBars());
                // Bars come back only while the player swipes from an edge, then hide again.
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_FULLSCREEN);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    // ---- Back and gestures ---------------------------------------------------------------------------------------

    /** Back never leaves the game: it toggles the in-game menu (the client's Backquote key). */
    private void onGameBack() {
        if (web != null && revealed) web.evaluateJavascript(MENU_KEY_SCRIPT, null);
        else moveTaskToBack(true); // still on the launch overlay: behave like Home
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        onGameBack(); // Android 8-12; 13+ uses the OnBackInvokedCallback registered in onCreate
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent event) {
        if (event.getActionMasked() == MotionEvent.ACTION_UP) lastGestureAt = SystemClock.uptimeMillis();
        return super.dispatchTouchEvent(event);
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getAction() == KeyEvent.ACTION_UP && event.getKeyCode() != KeyEvent.KEYCODE_BACK) lastGestureAt = SystemClock.uptimeMillis();
        return super.dispatchKeyEvent(event);
    }

    // ---- NativeBridge.Host ---------------------------------------------------------------------------------------

    @Override public String currentUrl() { return web == null ? null : web.getUrl(); }

    @Override public void evaluate(String script) { if (web != null) web.evaluateJavascript(script, null); }

    @Override
    public boolean consumeGesture() {
        boolean ok = BridgePolicy.gestureAllows(lastGestureAt, SystemClock.uptimeMillis());
        if (ok) lastGestureAt = 0; // one gesture, one external page
        return ok;
    }

    @Override public boolean openExternal(String url) { return openInBrowser(this, url); }

    @Override
    public GitHubDeviceFlow deviceFlow(String clientId, String scope, GitHubDeviceFlow.Callback callback) {
        String base = debugGithubBase;
        return base == null
            ? new GitHubDeviceFlow(this, clientId, scope, GitHubDeviceFlow.DEFAULT_WEB, GitHubDeviceFlow.DEFAULT_API, callback)
            : new GitHubDeviceFlow(this, clientId, scope, base, base, callback);
    }

    /** The name a server shows for this device's sign-in: the user's device name if set, else maker and model. */
    private String deviceName() {
        try {
            String name = android.provider.Settings.Global.getString(getContentResolver(), android.provider.Settings.Global.DEVICE_NAME);
            if (name != null && !name.trim().isEmpty()) return name;
        } catch (Exception unavailable) {
            // fall through
        }
        String model = Build.MODEL == null ? "" : Build.MODEL;
        String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
        return model.toLowerCase(java.util.Locale.ROOT).startsWith(maker.toLowerCase(java.util.Locale.ROOT)) ? model : (maker + " " + model).trim();
    }

    @Override
    public void signedOut(String reason) {
        signedOutReason = BridgePolicy.SIGN_OUT_REASONS.contains(reason) ? reason : "unauthorized";
        Log.i(TAG, "Signed out (" + signedOutReason + "); session keys cleared, reloading the game");
        // The reload re-runs the injected config without the cleared credentials; the page shows its setup/sign-in.
        if (web != null) web.loadUrl(AssetPolicy.START_URL);
    }

    /** Opens an https URL in the user's browser (never inside the game). */
    static boolean openInBrowser(Context context, String url) {
        String safe = BridgePolicy.externalUrl(url);
        if (safe == null) return false;
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(safe));
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
            return true;
        } catch (ActivityNotFoundException none) {
            return false;
        }
    }

    // ---- Debug-only test hooks (temporary; ignored unless the APK is debuggable) --------------------------------

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (handleInstallStatus(intent)) return;
        setIntent(intent);
        if (debuggable) handleDebugIntent(intent);
    }

    /**
     * TEMPORARY until the shared setup flow (CLOUD-03) lands. Debuggable builds only:
     *   --es ae.debug.login http://10.0.2.2:4706   signs in natively with POST /api/device/login and stores the session
     *   --es ae.debug.password <pw>               password for that call (default "fixture"; the UI fixture accepts any)
     *   --es ae.debug.github http://10.0.2.2:4707  points github.deviceFlow at a local fake GitHub
     *   --ez ae.debug.clear true                   deletes every secure key
     * Returns true if it will (re)load the game itself.
     */
    private boolean handleDebugIntent(Intent intent) {
        if (!debuggable || intent == null) return false;
        String updates = intent.getStringExtra("ae.debug.updates");
        if (updates != null) {
            // A loopback stand-in for GitHub releases; GameUpdater honours it only while the development key is pinned.
            updater.fixtureOrigin = ServerPolicy.isValid(updates, true) ? ServerPolicy.normalise(updates, true) : null;
            Log.i(TAG, "debug: update downloads from " + (updater.fixtureOrigin == null ? "GitHub" : updater.fixtureOrigin));
        }
        String github = intent.getStringExtra("ae.debug.github");
        if (github != null) {
            debugGithubBase = ServerPolicy.isValid(github, true) ? ServerPolicy.normalise(github, true) : null;
            Log.i(TAG, "debug: GitHub device flow base = " + (debugGithubBase == null ? "github.com" : debugGithubBase));
        }
        boolean clear = intent.getBooleanExtra("ae.debug.clear", false);
        String login = intent.getStringExtra("ae.debug.login");
        if (!clear && login == null) return false;
        String password = intent.getStringExtra("ae.debug.password");
        io.execute(() -> {
            try {
                if (clear) {
                    for (String key : BridgePolicy.KEYS) store.delete(key);
                    Log.i(TAG, "debug: secure storage cleared");
                }
                if (login != null) debugDeviceLogin(ServerPolicy.normalise(login, true), password == null ? "fixture" : password);
            } catch (Exception error) {
                Log.w(TAG, "debug: sign-in failed: " + error);
            }
            main.post(this::loadGame);
        });
        return true;
    }

    private void debugDeviceLogin(String origin, String password) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(origin + "/api/device/login").openConnection();
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(10000);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            byte[] body = new JSONObject().put("password", password).put("deviceName", "Android " + Build.MODEL).toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream out = connection.getOutputStream()) { out.write(body); }
            if (connection.getResponseCode() != 200) throw new IllegalStateException("HTTP " + connection.getResponseCode());
            ByteArrayOutputStream text = new ByteArrayOutputStream();
            try (InputStream in = connection.getInputStream()) {
                byte[] buffer = new byte[4096];
                int n;
                while ((n = in.read(buffer)) != -1) text.write(buffer, 0, n);
            }
            JSONObject result = new JSONObject(new String(text.toByteArray(), StandardCharsets.UTF_8));
            String token = result.getString("token");
            if (!BridgePolicy.isDeviceToken(token)) throw new IllegalStateException("Bad token shape");
            store.set("mode", "server");
            store.set("server.host", origin);
            store.set("server.token", token);
            if (result.has("deviceId")) store.set("server.deviceId", result.getString("deviceId"));
            Log.i(TAG, "debug: signed in to " + origin + " as device " + result.optString("deviceId"));
        } finally {
            connection.disconnect();
        }
    }

    // ---- Lifecycle -----------------------------------------------------------------------------------------------

    @Override
    protected void onResume() {
        super.onResume();
        hideSystemBars();
        if (web != null) { web.onResume(); web.resumeTimers(); }
    }

    @Override
    protected void onPause() {
        if (web != null) { web.onPause(); web.pauseTimers(); }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        main.removeCallbacks(trialCheck);
        if (Build.VERSION.SDK_INT >= 33 && backCallback != null) getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
        if (bridge != null) bridge.destroy();
        io.shutdown();
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
