package com.agentempire.mobile;

import java.net.URI;
import java.util.Locale;

/** No paths, credentials, queries or insecure origins may be saved as a host. */
public final class HostPolicy {
    private HostPolicy() {}
    public static String validate(String input) {
        try {
            URI uri = new URI(input.trim());
            if (uri.getRawQuery() != null || uri.getRawFragment() != null ||
                !(uri.getRawPath() == null || uri.getRawPath().isEmpty() || uri.getRawPath().equals("/"))) throw new IllegalArgumentException();
            return origin(uri);
        } catch (Exception error) { throw new IllegalArgumentException("Enter an HTTPS host address without a path, password, or token."); }
    }
    public static boolean allows(String trusted, String target) {
        try { return trusted.equals(origin(new URI(target))); }
        catch (Exception error) { return false; }
    }
    private static String origin(URI uri) {
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null || uri.getPort() == 0 || uri.getPort() > 65535) throw new IllegalArgumentException();
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        int port = uri.getPort();
        return "https://" + host + (port == -1 || port == 443 ? "" : ":" + port);
    }
}
