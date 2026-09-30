package com.agentempire.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PersistableBundle;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * GitHub OAuth device flow, run natively because GitHub's token endpoints send no CORS headers.
 *
 * 1. POST {web}/login/device/code (client_id, scope) returns device_code, user_code, verification_uri, interval.
 * 2. A native dialog shows the user code with "Copy code" and "Open GitHub" (the system browser, never the WebView).
 * 3. Poll POST {web}/login/oauth/access_token until the user approves: authorization_pending keeps polling,
 *    slow_down adds 5 seconds (or uses GitHub's new interval), expired_token / access_denied end the flow.
 * 4. GET {api}/user reads the login. The result is {token, login}; nothing is persisted here (the page decides).
 *
 * The token is never logged. Redirects are refused. Only one flow runs at a time (NativeBridge enforces it).
 */
final class GitHubDeviceFlow {
    private static final String TAG = "AgentEmpire";
    static final String DEFAULT_WEB = "https://github.com";
    static final String DEFAULT_API = "https://api.github.com";

    interface Callback {
        void success(String token, String login);
        /** code is one of: cancelled, expired_token, access_denied, network, github_error, invalid_request. */
        void failure(String code, String message);
    }

    private final Activity activity;
    private final String clientId, scope, webBase, apiBase;
    private final Callback callback;
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile boolean finished;
    private AlertDialog dialog;
    private TextView status;

    GitHubDeviceFlow(Activity activity, String clientId, String scope, String webBase, String apiBase, Callback callback) {
        this.activity = activity;
        this.clientId = clientId;
        this.scope = scope;
        this.webBase = webBase;
        this.apiBase = apiBase;
        this.callback = callback;
    }

    void start() {
        Thread worker = new Thread(this::run, "github-device-flow");
        worker.setDaemon(true);
        worker.start();
    }

    /** Ends the flow (activity destroyed, or the user cancelled). */
    void cancel() {
        finish(false, null, null, "cancelled", "GitHub sign-in was cancelled.");
    }

    private void run() {
        try {
            JSONObject code = post(webBase + "/login/device/code", "client_id=" + enc(clientId) + (scope.isEmpty() ? "" : "&scope=" + enc(scope)));
            if (code.has("error")) {
                finish(false, null, null, "github_error", describe(code));
                return;
            }
            String deviceCode = code.optString("device_code", ""), userCode = code.optString("user_code", "");
            String verification = code.optString("verification_uri", "");
            long interval = Math.max(1, code.optLong("interval", 5));
            long deadline = System.currentTimeMillis() + Math.max(60, Math.min(1800, code.optLong("expires_in", 900))) * 1000L;
            if (deviceCode.isEmpty() || userCode.isEmpty() || !BridgePolicy.isVerificationUrl(verification, webBase)) {
                finish(false, null, null, "github_error", "GitHub returned an unexpected device code response.");
                return;
            }
            main.post(() -> showDialog(userCode, verification));
            while (!finished) {
                sleep(interval * 1000L);
                if (finished) return;
                if (System.currentTimeMillis() > deadline) {
                    finish(false, null, null, "expired_token", "The GitHub code expired. Start sign-in again.");
                    return;
                }
                JSONObject poll;
                try {
                    poll = post(webBase + "/login/oauth/access_token", "client_id=" + enc(clientId) + "&device_code=" + enc(deviceCode)
                        + "&grant_type=" + enc("urn:ietf:params:oauth:grant-type:device_code"));
                } catch (IOException transient_) {
                    setStatus("Connection problem. Retrying…");
                    continue; // keep polling until the deadline
                }
                String token = poll.optString("access_token", "");
                if (!token.isEmpty()) {
                    setStatus("Approved. Finishing sign-in…");
                    finish(true, token, fetchLogin(token), null, null);
                    return;
                }
                String error = poll.optString("error", "");
                switch (error) {
                    case "authorization_pending":
                        break;
                    case "slow_down":
                        interval = poll.has("interval") ? Math.max(interval + 1, poll.optLong("interval")) : interval + 5;
                        setStatus("Waiting for approval on GitHub…");
                        break;
                    case "expired_token":
                        finish(false, null, null, "expired_token", "The GitHub code expired. Start sign-in again.");
                        return;
                    case "access_denied":
                        finish(false, null, null, "access_denied", "Sign-in was denied on GitHub.");
                        return;
                    default:
                        finish(false, null, null, "github_error", describe(poll));
                        return;
                }
            }
        } catch (IOException error) {
            finish(false, null, null, "network", "Could not reach GitHub. Check the connection and try again.");
        } catch (Exception error) {
            Log.w(TAG, "Device flow failed: " + error.getClass().getSimpleName());
            finish(false, null, null, "github_error", "GitHub sign-in failed.");
        }
    }

    /** The login is informational; a failure here still returns the token (login null). */
    private String fetchLogin(String token) {
        HttpURLConnection connection = null;
        try {
            connection = open(apiBase + "/user");
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setRequestProperty("Accept", "application/vnd.github+json");
            connection.setRequestProperty("X-GitHub-Api-Version", "2022-11-28");
            if (connection.getResponseCode() != 200) return null;
            String login = new JSONObject(read(connection.getInputStream())).optString("login", "");
            return login.isEmpty() ? null : login;
        } catch (Exception error) {
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private synchronized void finish(boolean ok, String token, String login, String code, String message) {
        if (finished) return;
        finished = true;
        main.post(() -> {
            if (dialog != null && dialog.isShowing() && !activity.isFinishing()) dialog.dismiss();
            dialog = null;
            if (ok) callback.success(token, login);
            else callback.failure(code, message);
        });
    }

    private void setStatus(String text) {
        main.post(() -> { if (status != null) status.setText(text); });
    }

    private void showDialog(String userCode, String verification) {
        if (finished || activity.isFinishing() || activity.isDestroyed()) return;
        Context context = activity;
        int pad = dp(20);
        LinearLayout body = new LinearLayout(context);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(pad, dp(8), pad, 0);
        TextView steps = new TextView(context);
        steps.setText("Open github.com/login/device in your browser and enter this code:");
        steps.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        steps.setTextColor(activity.getColor(R.color.brand_text));
        TextView code = new TextView(context);
        code.setText(userCode);
        code.setTextIsSelectable(true);
        code.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        code.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30);
        code.setLetterSpacing(0.12f);
        code.setTextColor(activity.getColor(R.color.brand_lit));
        code.setGravity(Gravity.CENTER);
        code.setPadding(0, dp(14), 0, dp(10));
        code.setContentDescription("GitHub code " + userCode.replace("", " ").trim());
        status = new TextView(context);
        status.setText("Waiting for approval on GitHub…");
        status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        status.setTextColor(activity.getColor(R.color.brand_muted));
        status.setGravity(Gravity.CENTER);
        status.setAccessibilityLiveRegion(TextView.ACCESSIBILITY_LIVE_REGION_POLITE);
        body.addView(steps);
        body.addView(code);
        body.addView(status);
        dialog = new AlertDialog.Builder(context, R.style.DialogTheme)
            .setTitle("Sign in with GitHub")
            .setView(body)
            .setPositiveButton("Open GitHub", null)
            .setNeutralButton("Copy code", null)
            .setNegativeButton("Cancel", (d, which) -> cancel())
            .setOnCancelListener(d -> cancel())
            .create();
        dialog.setCanceledOnTouchOutside(false);
        dialog.setOnShowListener(d -> {
            // These two must not close the dialog; the flow keeps polling.
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> MainActivity.openInBrowser(activity, verification));
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(v -> copy(userCode));
        });
        dialog.show();
    }

    private void copy(String userCode) {
        ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
        ClipData clip = ClipData.newPlainText("GitHub code", userCode);
        if (Build.VERSION.SDK_INT >= 24) {
            PersistableBundle extras = new PersistableBundle();
            extras.putBoolean("android.content.extra.IS_SENSITIVE", false);
            clip.getDescription().setExtras(extras);
        }
        clipboard.setPrimaryClip(clip);
        // Android 13+ shows its own clipboard confirmation.
        if (Build.VERSION.SDK_INT < 33) Toast.makeText(activity, "Code copied", Toast.LENGTH_SHORT).show();
        if (status != null) status.setText("Code copied. Paste it on GitHub, then approve.");
    }

    private int dp(int value) {
        return Math.round(value * activity.getResources().getDisplayMetrics().density);
    }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(20000);
        connection.setUseCaches(false);
        connection.setRequestProperty("User-Agent", "AgentEmpire-Android");
        return connection;
    }

    private static JSONObject post(String url, String form) throws IOException {
        HttpURLConnection connection = open(url);
        try {
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
            byte[] body = form.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream out = connection.getOutputStream()) { out.write(body); }
            int status = connection.getResponseCode();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String text = stream == null ? "" : read(stream);
            try {
                return new JSONObject(text);
            } catch (Exception notJson) {
                if (status >= 500 || status == 429) throw new IOException("GitHub HTTP " + status);
                return new JSONObject().put("error", "http_" + status);
            }
        } catch (org.json.JSONException impossible) {
            throw new IOException(impossible);
        } finally {
            connection.disconnect();
        }
    }

    private static String read(InputStream in) throws IOException {
        try (InputStream stream = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int n, total = 0;
            while ((n = stream.read(buffer)) != -1) {
                total += n;
                if (total > 65536) throw new IOException("Response too large");
                out.write(buffer, 0, n);
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static String describe(JSONObject error) {
        String description = error.optString("error_description", "");
        String code = error.optString("error", "unknown");
        if (code.equals("incorrect_client_credentials")) return "This app's GitHub client id is not valid.";
        if (code.equals("device_flow_disabled")) return "Device sign-in is not enabled for this GitHub app.";
        return description.isEmpty() ? "GitHub error: " + code : description;
    }

    private static String enc(String value) {
        try { return URLEncoder.encode(value, "UTF-8"); } catch (Exception impossible) { throw new IllegalStateException(impossible); }
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
    }
}
