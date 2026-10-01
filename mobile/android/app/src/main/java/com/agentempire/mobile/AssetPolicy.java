package com.agentempire.mobile;

import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Pure policy for the bundled game origin (no Android types, so it is unit-tested on the desktop JVM).
 *
 * The game (a copy of dist/public) lives in the APK under assets/game/ and is served only at
 * https://appassets.androidplatform.net/. This class decides which URLs belong to that origin, maps a request path
 * to an asset path (refusing traversal, encoded separators, hidden files and anything unusual), and names the MIME type.
 */
public final class AssetPolicy {
    private AssetPolicy() {}

    public static final String HOST = "appassets.androidplatform.net";
    public static final String ORIGIN = "https://" + HOST;
    /** The start page. */
    public static final String START_URL = ORIGIN + "/";
    /** Asset folder inside the APK. */
    public static final String ASSET_ROOT = "game";
    /** Synthetic script with the injected window.AGENT_EMPIRE_APP (see GameAssets). Never a real asset. */
    public static final String CONFIG_PATH = "/__agent-empire/app-config.js";

    /** True only when the URL's origin is exactly https://appassets.androidplatform.net (default port, no userinfo). */
    public static boolean isAppOrigin(String url) {
        if (url == null) return false;
        try {
            URI uri = new URI(url);
            String authority = uri.getRawAuthority(); // includes any userinfo, so "user@host" never matches
            return "https".equalsIgnoreCase(uri.getScheme()) && authority != null
                && (authority.equalsIgnoreCase(HOST) || authority.equalsIgnoreCase(HOST + ":443"));
        } catch (Exception malformed) {
            return false;
        }
    }

    /**
     * Maps a raw (still percent-encoded) URL path to "game/..." or returns null, which the loader answers with 404.
     * "/" is index.html. Directory listings, "." and ".." segments, empty segments, hidden files, backslashes,
     * encoded "/" "\" or NUL, control characters and invalid escapes are all refused.
     */
    public static String assetPath(String rawPath) {
        if (rawPath == null || rawPath.isEmpty() || rawPath.charAt(0) != '/' || rawPath.length() > 512) return null;
        if (rawPath.equals("/")) return ASSET_ROOT + "/index.html";
        if (rawPath.endsWith("/")) return null;
        String path = decode(rawPath);
        if (path == null) return null;
        String[] segments = path.substring(1).split("/", -1);
        StringBuilder out = new StringBuilder(ASSET_ROOT);
        for (String segment : segments) {
            if (segment.isEmpty() || segment.startsWith(".")) return null; // also rejects "." and ".."
            for (int i = 0; i < segment.length(); i++) if (!allowed(segment.charAt(i))) return null;
            out.append('/').append(segment);
        }
        return out.toString();
    }

    private static boolean allowed(char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || "-_.~@+,=()!$&' ".indexOf(c) >= 0;
    }

    /** Strict percent-decoding (UTF-8). '+' stays '+'. Encoded '/', '\' and NUL are refused. */
    static String decode(String raw) {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (c == '%') {
                if (i + 2 >= raw.length()) return null;
                int hi = Character.digit(raw.charAt(i + 1), 16), lo = Character.digit(raw.charAt(i + 2), 16);
                if (hi < 0 || lo < 0) return null;
                int b = hi * 16 + lo;
                if (b == '/' || b == '\\' || b == 0) return null;
                bytes.write(b);
                i += 2;
            } else if (c > 0x7e || c < 0x20 || c == '\\') {
                return null;
            } else {
                bytes.write(c);
            }
        }
        String decoded = new String(bytes.toByteArray(), StandardCharsets.UTF_8);
        return decoded.indexOf('�') >= 0 ? null : decoded;
    }

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        String[][] table = {
            {"html", "text/html"}, {"htm", "text/html"}, {"js", "text/javascript"}, {"mjs", "text/javascript"},
            {"css", "text/css"}, {"json", "application/json"}, {"map", "application/json"}, {"webmanifest", "application/manifest+json"},
            {"txt", "text/plain"}, {"md", "text/markdown"}, {"xml", "application/xml"}, {"svg", "image/svg+xml"},
            {"png", "image/png"}, {"jpg", "image/jpeg"}, {"jpeg", "image/jpeg"}, {"webp", "image/webp"}, {"gif", "image/gif"},
            {"avif", "image/avif"}, {"ico", "image/x-icon"}, {"ktx2", "image/ktx2"}, {"hdr", "application/octet-stream"},
            {"exr", "application/octet-stream"}, {"glb", "model/gltf-binary"}, {"gltf", "model/gltf+json"}, {"bin", "application/octet-stream"},
            {"wasm", "application/wasm"}, {"wav", "audio/wav"}, {"mp3", "audio/mpeg"}, {"ogg", "audio/ogg"}, {"m4a", "audio/mp4"},
            {"aac", "audio/aac"}, {"mp4", "video/mp4"}, {"webm", "video/webm"}, {"woff", "font/woff"}, {"woff2", "font/woff2"},
            {"ttf", "font/ttf"}, {"otf", "font/otf"},
        };
        for (String[] row : table) MIME.put(row[0], row[1]);
    }

    /** MIME type by extension; unknown types are application/octet-stream (served with nosniff). */
    public static String mimeType(String path) {
        int slash = path.lastIndexOf('/'), dot = path.lastIndexOf('.');
        if (dot <= slash) return "application/octet-stream";
        String type = MIME.get(path.substring(dot + 1).toLowerCase(Locale.ROOT));
        return type == null ? "application/octet-stream" : type;
    }

    /** Text types get an explicit UTF-8 encoding. */
    public static boolean isText(String mime) {
        return mime.startsWith("text/") || mime.equals("application/json") || mime.equals("application/manifest+json")
            || mime.equals("image/svg+xml") || mime.equals("application/xml") || mime.equals("model/gltf+json");
    }

    /**
     * Inserts the config script tag as the first element of <head>, so window.AGENT_EMPIRE_APP exists before any
     * page script (the game's scripts are modules, which run after this classic, blocking script).
     * Returns null when the document has no <head> tag (the caller then refuses to serve it).
     */
    /**
     * Content-Security-Policy of every HTML document GameAssets serves (the only HTML path). frame-src 'self' keeps
     * other origins' documents out of the game, so no foreign frame shares the window where window.empireAndroid lives.
     */
    public static final String HTML_CSP = "frame-src 'self'; child-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'";

    /** Headers added to an HTML document's response (besides the shared nosniff headers). */
    public static java.util.Map<String, String> htmlHeaders() {
        java.util.Map<String, String> headers = new java.util.LinkedHashMap<>();
        headers.put("Cache-Control", "no-cache");
        headers.put("Content-Security-Policy", HTML_CSP);
        return headers;
    }

    public static String injectConfigScript(String html) {
        String lower = html.toLowerCase(Locale.ROOT);
        int head = lower.indexOf("<head");
        while (head >= 0 && head + 5 < lower.length() && lower.charAt(head + 5) != '>' && !Character.isWhitespace(lower.charAt(head + 5)))
            head = lower.indexOf("<head", head + 5); // skip <header>
        if (head < 0) return null;
        int close = lower.indexOf('>', head);
        if (close < 0) return null;
        String tag = "<script src=\"" + CONFIG_PATH + "\"></script>";
        return html.substring(0, close + 1) + tag + html.substring(close + 1);
    }
}
