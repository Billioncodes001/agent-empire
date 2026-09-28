package com.agentempire.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Color;
import android.net.http.SslError;
import android.os.Bundle;
import android.view.View;
import android.webkit.*;
import android.widget.*;

/** A host controller. It never starts a server, holds provider keys, or exposes a native JS bridge. */
public final class MainActivity extends Activity {
    private static final int INK = Color.rgb(16, 30, 37), PAPER = Color.rgb(235, 237, 227);
    private WebView web;
    private TextView status;
    private String origin;
    private boolean pageFailed;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        String previous = state == null ? null : state.getString("connectedOrigin");
        if (previous != null) {
            try { openHost(HostPolicy.validate(previous)); return; } catch (IllegalArgumentException ignored) {}
        }
        showHosts();
    }
    @Override protected void onSaveInstanceState(Bundle state) { if (origin != null) state.putString("connectedOrigin", origin); super.onSaveInstanceState(state); }
    private int dp(int n) { return Math.round(n * getResources().getDisplayMetrics().density); }
    private LinearLayout column() {
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(INK);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(dp(16) + insets.getSystemWindowInsetLeft(), dp(12) + insets.getSystemWindowInsetTop(), dp(16) + insets.getSystemWindowInsetRight(), dp(12) + insets.getSystemWindowInsetBottom());
            return insets;
        });
        setContentView(root); root.requestApplyInsets(); return root;
    }
    private TextView text(String value, int size) { TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(PAPER); view.setPadding(0, dp(8), 0, dp(8)); return view; }
    private Button button(String title, View.OnClickListener click) { Button b = new Button(this); b.setText(title); b.setOnClickListener(click); return b; }
    private void disposeWeb() { if (web != null) { web.stopLoading(); web.destroy(); web = null; } }
    private void showHosts() {
        disposeWeb(); origin = null;
        LinearLayout root = column();
        root.addView(text("AGENT EMPIRE", 28)); root.addView(text("Your city, from your phone", 19));
        root.addView(text("Connect to an existing Agent Empire host over HTTPS, then sign in on its login page. Only connect to a host you trust.", 16));
        root.addView(text("This companion needs your host online. It does not include an offline world or run local agents. Accepted cloud jobs continue when you close it. Rotate to landscape for a wider view.", 15));
        EditText host = new EditText(this); host.setSingleLine(); host.setTextColor(PAPER); host.setHintTextColor(Color.LTGRAY); host.setHint("https://city.example.com"); host.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        host.setText(getPreferences(MODE_PRIVATE).getString("origin", "")); root.addView(host);
        TextView error = text("", 14);
        root.addView(button("Connect to host", ignored -> {
            try { String address = HostPolicy.validate(host.getText().toString()); getPreferences(MODE_PRIVATE).edit().putString("origin", address).apply(); openHost(address); }
            catch (IllegalArgumentException invalid) { error.setText(invalid.getMessage()); }
        }));
        root.addView(error);
        root.addView(button("Forget saved host and sessions", ignored -> new AlertDialog.Builder(this).setTitle("Forget this phone's sessions?").setMessage("This signs this companion out. It does not stop host or cloud jobs.").setNegativeButton("Cancel", null).setPositiveButton("Forget", (dialog, which) -> {
            CookieManager.getInstance().removeAllCookies(done -> CookieManager.getInstance().flush()); WebStorage.getInstance().deleteAllData(); getPreferences(MODE_PRIVATE).edit().clear().apply(); host.setText(""); error.setText("Saved host and browser sessions cleared.");
        }).show()));
    }
    @SuppressWarnings("deprecation") private void openHost(String address) {
        disposeWeb(); origin = address; pageFailed = false;
        LinearLayout root = column();
        LinearLayout bar = new LinearLayout(this);
        bar.addView(button("Hosts", ignored -> showHosts())); bar.addView(button("Reload", ignored -> { if (web != null) { pageFailed = false; web.setVisibility(View.VISIBLE); web.loadUrl(origin + "/"); } }));
        for (int i = 0; i < bar.getChildCount(); i++) { Button b = (Button)bar.getChildAt(i); b.setTextSize(12); b.setMinimumHeight(0); b.setMinHeight(0); b.setPadding(dp(10), 0, dp(10), 0); b.setLayoutParams(new LinearLayout.LayoutParams(-2, dp(36))); }
        root.addView(bar);
        status = text(address, 12); status.setMaxLines(2); status.setPadding(0, dp(2), 0, dp(2)); root.addView(status);
        web = new WebView(this); root.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        WebSettings settings = web.getSettings(); settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false); settings.setAllowFileAccessFromFileURLs(false); settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW); settings.setGeolocationEnabled(false); settings.setMediaPlaybackRequiresUserGesture(true); settings.setSavePassword(false); settings.setSupportMultipleWindows(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, android.os.Message result) { return false; }
        });
        web.setDownloadListener((url, userAgent, disposition, mime, length) -> status.setText("Downloads are unavailable in this companion. Use your desktop browser."));
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                // POST navigations do not invoke shouldOverrideUrlLoading; block those too.
                if (request.isForMainFrame() && !HostPolicy.allows(origin, request.getUrl().toString()))
                    return new WebResourceResponse("text/plain", "utf-8", 403, "Blocked", java.util.Collections.emptyMap(), new java.io.ByteArrayInputStream("Navigation outside the selected host is blocked.".getBytes(java.nio.charset.StandardCharsets.UTF_8)));
                return null;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                boolean blocked = !HostPolicy.allows(origin, request.getUrl().toString());
                if (blocked) { pageFailed = true; status.setText("Navigation outside your selected HTTPS host was blocked."); }
                return blocked;
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                if (!HostPolicy.allows(origin, url)) { pageFailed = true; view.stopLoading(); status.setText("Navigation outside your selected host was blocked."); }
                // A new load on the host (Back, a link, Reload) starts clean; a failure hides the view again.
                else { pageFailed = false; view.setVisibility(View.VISIBLE); status.setText(origin + " · connecting…"); }
            }
            @Override public void onPageFinished(WebView view, String url) { if (!pageFailed && HostPolicy.allows(origin, url)) status.setText(origin); }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) { handler.cancel(); fail(view, "Certificate validation failed. Fix the host certificate; no exception is allowed."); }
            @Override public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler, String host, String realm) { handler.cancel(); pageFailed = true; status.setText("Use the host's standard sign-in page. HTTP authentication is unsupported."); }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) { if (request.isForMainFrame()) fail(view, "Host unavailable. Keep the host online, then tap Reload."); }
        });
        web.loadUrl(origin + "/");
    }
    /** Our own message only: hide the WebView so its stock error page (often from an earlier attempt) never contradicts it. */
    private void fail(WebView view, String message) { pageFailed = true; view.stopLoading(); view.setVisibility(View.INVISIBLE); status.setText(message); }
    @Override public void onBackPressed() { if (web != null && web.canGoBack()) web.goBack(); else if (web != null) showHosts(); else super.onBackPressed(); }
    @Override public void onPause() { if (web != null) web.onPause(); CookieManager.getInstance().flush(); super.onPause(); }
    @Override public void onResume() { super.onResume(); if (web != null) web.onResume(); }
    @Override public void onDestroy() { disposeWeb(); super.onDestroy(); }
}
