package com.agentempire.mobile;

import android.content.res.AssetManager;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * Serves the bundled game from APK assets (assets/game, a copy of dist/public) at https://appassets.androidplatform.net/.
 * This replaces androidx.webkit's WebViewAssetLoader: GET/HEAD only, paths checked by AssetPolicy, correct MIME types,
 * 404 for anything unknown. HTML documents get the config script injected as the first element of <head>.
 */
final class GameAssets {
    /** Produces the body of the synthetic config script for each page load (reads secure storage). */
    interface ConfigSource { String configScript(); }

    private final AssetManager assets;
    private final ConfigSource config;

    GameAssets(AssetManager assets, ConfigSource config) {
        this.assets = assets;
        this.config = config;
    }

    /** Only called for app-origin URLs. Never returns null, so nothing on this origin reaches the network. */
    WebResourceResponse handle(WebResourceRequest request) {
        Uri url = request.getUrl();
        String method = request.getMethod() == null ? "GET" : request.getMethod();
        if (!method.equals("GET") && !method.equals("HEAD")) return text(405, "Method Not Allowed");
        String rawPath = url.getEncodedPath() == null ? "/" : url.getEncodedPath();
        if (rawPath.equals(AssetPolicy.CONFIG_PATH)) {
            Map<String, String> headers = baseHeaders();
            headers.put("Cache-Control", "no-store");
            return response("text/javascript", 200, "OK", headers, config.configScript().getBytes(StandardCharsets.UTF_8));
        }
        String asset = AssetPolicy.assetPath(rawPath);
        if (asset == null) return text(404, "Not Found");
        String mime = AssetPolicy.mimeType(asset);
        InputStream in;
        try {
            in = assets.open(asset, AssetManager.ACCESS_STREAMING);
        } catch (IOException missing) {
            return text(404, "Not Found");
        }
        Map<String, String> headers = baseHeaders();
        if (mime.equals("text/html")) {
            String html;
            try {
                html = new String(readAll(in), StandardCharsets.UTF_8);
            } catch (IOException error) {
                return text(500, "Internal Error");
            }
            String injected = AssetPolicy.injectConfigScript(html);
            if (injected == null) return text(500, "Internal Error");
            headers.put("Cache-Control", "no-cache");
            // No foreign frames or plugins inside the game; this keeps the bridge away from other origins' documents.
            headers.put("Content-Security-Policy", "frame-src 'self'; child-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'");
            return response(mime, 200, "OK", headers, injected.getBytes(StandardCharsets.UTF_8));
        }
        headers.put("Cache-Control", rawPath.startsWith("/assets/") ? "max-age=31536000, immutable" : "no-cache");
        return new WebResourceResponse(mime, AssetPolicy.isText(mime) ? "utf-8" : null, 200, "OK", headers, in);
    }

    static WebResourceResponse text(int status, String reason) {
        return response("text/plain", status, reason, baseHeaders(), (status + " " + reason).getBytes(StandardCharsets.UTF_8));
    }

    private static WebResourceResponse response(String mime, int status, String reason, Map<String, String> headers, byte[] body) {
        return new WebResourceResponse(mime, "utf-8", status, reason, headers, new ByteArrayInputStream(body));
    }

    private static Map<String, String> baseHeaders() {
        Map<String, String> headers = new HashMap<>();
        headers.put("X-Content-Type-Options", "nosniff");
        headers.put("Referrer-Policy", "no-referrer");
        return headers;
    }

    private static byte[] readAll(InputStream in) throws IOException {
        try (InputStream stream = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[16384];
            int n;
            while ((n = stream.read(buffer)) != -1) out.write(buffer, 0, n);
            return out.toByteArray();
        }
    }
}
