package com.agentempire.mobile;

import java.net.URI;
import java.util.Locale;

/**
 * Validates an Empire server address before the shell hands it to the game (window.AGENT_EMPIRE_APP.host) or
 * talks to it natively. Kept from the old host picker: no paths, queries, fragments, credentials or bad ports.
 * Release builds accept HTTPS only. Debuggable builds also accept http:// for the local test hosts that the debug
 * network security config allows (10.0.2.2, 127.0.0.1, localhost), and nothing else.
 */
public final class ServerPolicy {
    private ServerPolicy() {}

    private static final String[] DEBUG_HTTP_HOSTS = {"10.0.2.2", "127.0.0.1", "localhost"};

    /** Returns the normalised origin ("https://host[:port]"), or throws IllegalArgumentException. */
    public static String normalise(String input, boolean debuggable) {
        if (input == null) throw invalid();
        try {
            String trimmed = input.trim();
            if (trimmed.indexOf('\\') >= 0 || trimmed.length() > 300) throw invalid();
            URI uri = new URI(trimmed);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if (uri.getRawQuery() != null || uri.getRawFragment() != null || uri.getRawUserInfo() != null || uri.getHost() == null
                || !(uri.getRawPath() == null || uri.getRawPath().isEmpty() || uri.getRawPath().equals("/"))) throw invalid();
            int port = uri.getPort();
            if (port == 0 || port > 65535) throw invalid();
            String host = uri.getHost().toLowerCase(Locale.ROOT);
            if (scheme.equals("https")) return "https://" + host + (port == -1 || port == 443 ? "" : ":" + port);
            if (scheme.equals("http") && debuggable) {
                for (String allowed : DEBUG_HTTP_HOSTS) if (allowed.equals(host)) return "http://" + host + (port == -1 || port == 80 ? "" : ":" + port);
            }
            throw invalid();
        } catch (IllegalArgumentException error) {
            throw error;
        } catch (Exception error) {
            throw invalid();
        }
    }

    public static boolean isValid(String input, boolean debuggable) {
        try { normalise(input, debuggable); return true; } catch (IllegalArgumentException error) { return false; }
    }

    private static IllegalArgumentException invalid() {
        return new IllegalArgumentException("Enter an HTTPS server address without a path, password or token.");
    }
}
