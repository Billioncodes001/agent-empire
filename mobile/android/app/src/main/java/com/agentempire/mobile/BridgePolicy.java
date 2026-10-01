package com.agentempire.mobile;

import java.net.URI;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Pure rules for the native bridge (docs/team/CLOUD_MODE_PLAN.md, "Native bridge contract"). No Android types, so
 * the desktop JVM test covers them. NativeBridge enforces these on every call.
 */
public final class BridgePolicy {
    private BridgePolicy() {}

    /** The only methods the page can call. Nothing else is exposed. */
    public static final Set<String> METHODS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "secure.get", "secure.set", "secure.delete", "github.deviceFlow", "app.signedOut", "app.openExternal")));

    /** Fixed key allowlist for secure.get/set/delete. */
    public static final List<String> KEYS = Collections.unmodifiableList(Arrays.asList(
        "mode", "server.host", "server.token", "server.deviceId", "github.token", "github.login", "state.repo"));

    /** Cleared by app.signedOut: every credential and the identity bound to it. Preferences (mode, host, repo) stay. */
    public static final List<String> SESSION_KEYS = Collections.unmodifiableList(Arrays.asList(
        "server.token", "server.deviceId", "github.token", "github.login"));

    public static final int MAX_VALUE_LENGTH = 8192;
    public static final int MAX_MESSAGE_LENGTH = 16384;
    /** How long after a real touch or key press app.openExternal is still accepted. */
    public static final long GESTURE_WINDOW_MS = 5000;

    private static final Pattern ID = Pattern.compile("[A-Za-z0-9_.:-]{1,64}");
    private static final Pattern CLIENT_ID = Pattern.compile("[A-Za-z0-9._-]{1,100}");
    /** The only GitHub scopes the page may request (same set as iOS BridgeProtocol.githubScopes). */
    public static final Set<String> GITHUB_SCOPES = Collections.unmodifiableSet(new HashSet<>(Arrays.asList("repo", "workflow", "read:user")));
    /** Reasons the page may give for app.signedOut (same set as iOS). */
    public static final Set<String> SIGN_OUT_REASONS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList("user", "revoked", "unauthorized")));
    private static final Pattern DEVICE_TOKEN = Pattern.compile("[A-Za-z0-9_-]{16,256}");
    private static final Pattern DEVICE_ID = Pattern.compile("[A-Za-z0-9_-]{1,128}");
    private static final Pattern GITHUB_LOGIN = Pattern.compile("[A-Za-z0-9][A-Za-z0-9-]{0,38}");
    private static final Pattern STATE_REPO = Pattern.compile("[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}");

    public static boolean isKey(String key) { return key != null && KEYS.contains(key); }
    public static boolean isMethod(String method) { return method != null && METHODS.contains(method); }
    public static boolean isRequestId(String id) { return id != null && ID.matcher(id).matches(); }
    public static boolean isClientId(String id) { return id != null && CLIENT_ID.matcher(id).matches(); }
    public static boolean isValue(String value) { return value != null && value.length() <= MAX_VALUE_LENGTH; }
    public static boolean isDeviceToken(String token) { return token != null && DEVICE_TOKEN.matcher(token).matches(); }

    /**
     * Joins requested scopes for GitHub ("repo workflow"), de-duplicated in order; null unless every scope is one of
     * GITHUB_SCOPES and at least one is requested (iOS BridgeProtocol.deviceFlow applies the same rule).
     */
    public static String scopes(List<String> scopes) {
        if (scopes == null || scopes.isEmpty() || scopes.size() > 10) return null;
        Set<String> seen = new LinkedHashSet<>();
        for (String scope : scopes) {
            if (scope == null || !GITHUB_SCOPES.contains(scope)) return null;
            seen.add(scope);
        }
        return String.join(" ", seen);
    }

    /**
     * What may be stored under each key (same rules as iOS BridgeProtocol.validate); anything else is refused before
     * it reaches secure storage. Returns null when the value is acceptable, else the message for the page.
     */
    public static String invalidValue(String key, String value, boolean debuggable) {
        if (!isKey(key)) return "Key not allowed";
        if (value == null || value.isEmpty() || value.length() > MAX_VALUE_LENGTH) return "That value can't be stored.";
        switch (key) {
            case "mode": return value.equals("cloud") || value.equals("server") ? null : "Unknown mode.";
            case "server.host":
                try {
                    return ServerPolicy.normalise(value, debuggable).equals(value) ? null : "That server address isn't allowed in this build.";
                } catch (IllegalArgumentException bad) {
                    return "That server address isn't allowed in this build.";
                }
            case "server.token": return isDeviceToken(value) ? null : "Malformed device token.";
            case "server.deviceId": return DEVICE_ID.matcher(value).matches() ? null : "Malformed device id.";
            case "github.token": return value.length() <= 512 && !value.matches("(?s).*\\s.*") ? null : "Malformed GitHub token.";
            case "github.login": return GITHUB_LOGIN.matcher(value).matches() ? null : "Malformed GitHub login.";
            case "state.repo": return STATE_REPO.matcher(value).matches() ? null : "Malformed repository name.";
            default: return "Key not allowed";
        }
    }

    /**
     * The fields of window.AGENT_EMPIRE_APP besides platform/appVersion/bridge, with the same rules as iOS
     * BridgeProtocol.configScript: the device name, the stored mode, a server session only in server mode (or with no
     * mode, for APP-02 sessions) when host and token are valid, and a one-shot sign-out reason.
     */
    public static Map<String, String> configFields(String deviceName, String mode, String host, String token, String deviceId, String signedOut, boolean debuggable) {
        Map<String, String> out = new LinkedHashMap<>();
        String name = deviceName == null ? "" : deviceName.trim();
        out.put("deviceName", name.isEmpty() ? "Android" : name.length() > 64 ? name.substring(0, 64) : name);
        boolean known = "cloud".equals(mode) || "server".equals(mode);
        if (known) out.put("mode", mode);
        if ((mode == null || "server".equals(mode)) && host != null && token != null && ServerPolicy.isValid(host, debuggable) && isDeviceToken(token)) {
            out.put("host", ServerPolicy.normalise(host, debuggable));
            out.put("token", token);
            if (deviceId != null && DEVICE_ID.matcher(deviceId).matches()) out.put("deviceId", deviceId);
        }
        if (signedOut != null && SIGN_OUT_REASONS.contains(signedOut)) out.put("signedOut", signedOut);
        return out;
    }

    /**
     * app.openExternal and user-tapped links: a plain https URL with a host and no credentials, else null.
     * Returns the URL as given (the browser re-parses it).
     */
    public static String externalUrl(String url) {
        if (url == null || url.length() > 2048) return null;
        try {
            URI uri = new URI(url.trim());
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null) return null;
            if (AssetPolicy.isAppOrigin(url)) return null; // the bundled origin has no meaning outside the app
            return uri.toASCIIString();
        } catch (Exception malformed) {
            return null;
        }
    }

    /** The verification page GitHub returned must be on the expected GitHub web origin (release: https://github.com). */
    public static boolean isVerificationUrl(String url, String githubWebOrigin) {
        if (url == null) return false;
        try {
            URI uri = new URI(url);
            URI base = new URI(githubWebOrigin);
            return uri.getRawUserInfo() == null && uri.getScheme() != null && uri.getScheme().equalsIgnoreCase(base.getScheme())
                && uri.getHost() != null && uri.getHost().toLowerCase(Locale.ROOT).equals(base.getHost().toLowerCase(Locale.ROOT))
                && uri.getPort() == base.getPort();
        } catch (Exception malformed) {
            return false;
        }
    }

    /** True if a user gesture happened recently enough to allow opening the system browser. */
    public static boolean gestureAllows(long lastGestureAt, long now) {
        return lastGestureAt > 0 && now >= lastGestureAt && now - lastGestureAt <= GESTURE_WINDOW_MS;
    }
}
