package com.agentempire.mobile;

import java.net.URI;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
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
    private static final Pattern SCOPE = Pattern.compile("[a-z0-9:_-]{1,64}");
    private static final Pattern DEVICE_TOKEN = Pattern.compile("[A-Za-z0-9_-]{16,256}");

    public static boolean isKey(String key) { return key != null && KEYS.contains(key); }
    public static boolean isMethod(String method) { return method != null && METHODS.contains(method); }
    public static boolean isRequestId(String id) { return id != null && ID.matcher(id).matches(); }
    public static boolean isClientId(String id) { return id != null && CLIENT_ID.matcher(id).matches(); }
    public static boolean isValue(String value) { return value != null && value.length() <= MAX_VALUE_LENGTH; }
    public static boolean isDeviceToken(String token) { return token != null && DEVICE_TOKEN.matcher(token).matches(); }

    /** Joins requested scopes for GitHub ("repo workflow"); null if any scope is malformed or there are too many. */
    public static String scopes(List<String> scopes) {
        if (scopes == null || scopes.size() > 10) return null;
        StringBuilder out = new StringBuilder();
        for (String scope : scopes) {
            if (scope == null || !SCOPE.matcher(scope).matches()) return null;
            if (out.length() > 0) out.append(' ');
            out.append(scope);
        }
        return out.toString();
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
