package com.agentempire.mobile;

import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Pure rules for in-app updates (docs/team/RELEASE_PLAN.md, REL-04), with no Android types so PolicyTest covers them on
 * the desktop JVM. GameUpdater (files, downloads, the installer) applies them. Same rules as desktop/bridge-policy.cjs,
 * desktop/update-store.cjs and iOS UpdatePolicy.swift.
 */
public final class UpdatePolicy {
    private UpdatePolicy() {}

    /**
     * The pinned release key (src/shared/release-key.ts; listed in tools/release/config.json pinnedKeyFiles so the
     * release gate checks this copy). While it is the development key, a debuggable build honours the loopback
     * update fixture; the page verifies channel signatures against the same key.
     */
    public static final String DEV_RELEASE_PUBLIC_KEY = "q7m8HRpNA8EClSZsC3KSzzInRy3LxrjPIXNU41+WLYU=";
    public static final String RELEASE_PUBLIC_KEY = "q7m8HRpNA8EClSZsC3KSzzInRy3LxrjPIXNU41+WLYU=";
    public static final boolean RELEASE_KEY_IS_DEVELOPMENT = RELEASE_PUBLIC_KEY.equals(DEV_RELEASE_PUBLIC_KEY);

    /** Releases come only from this repository (src/client/update/channel.ts RELEASE_REPO). */
    public static final String RELEASE_REPO = "Billioncodes001/agent-empire";
    public static final String RELEASES_API = "https://api.github.com/repos/" + RELEASE_REPO + "/releases?per_page=20";
    /** Hosts a github.com release download may redirect to. */
    public static final List<String> ASSET_REDIRECT_HOSTS = Collections.unmodifiableList(Arrays.asList("objects.githubusercontent.com", "release-assets.githubusercontent.com"));
    public static final long BOOT_TIMEOUT_MS = 20_000;
    public static final long MAX_TEXT_BYTES = 6L * 1024 * 1024;
    public static final long MAX_ZIP_BYTES = 512L * 1024 * 1024;
    public static final long MAX_APK_BYTES = 512L * 1024 * 1024;
    public static final long MAX_UNPACKED_BYTES = 1024L * 1024 * 1024;
    public static final int MAX_ENTRIES = 20_000;

    private static final String ID = "(?:0|[1-9]\\d{0,8}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
    private static final Pattern SEMVER = Pattern.compile("(0|[1-9]\\d{0,8})\\.(0|[1-9]\\d{0,8})\\.(0|[1-9]\\d{0,8})(?:-(" + ID + "(?:\\." + ID + ")*))?");
    private static final Pattern SHA256 = Pattern.compile("[0-9a-f]{64}");
    private static final Pattern SEGMENT = Pattern.compile("[A-Za-z0-9._+-]{1,128}");
    private static final Pattern ETAG = Pattern.compile("[\\x21-\\x7e]{1,200}");

    public static boolean isSemver(String v) { return v != null && v.length() <= 64 && SEMVER.matcher(v).matches(); }
    public static boolean isSha256(String v) { return v != null && SHA256.matcher(v).matches(); }
    public static boolean isEtag(String v) { return v != null && ETAG.matcher(v).matches(); }

    /** SemVer 2.0 precedence; both must be valid versions. */
    public static int compare(String a, String b) {
        Matcher x = SEMVER.matcher(a), y = SEMVER.matcher(b);
        if (!x.matches() || !y.matches()) throw new IllegalArgumentException("Not a version");
        for (int i = 1; i <= 3; i++) {
            int c = Long.compare(Long.parseLong(x.group(i)), Long.parseLong(y.group(i)));
            if (c != 0) return c;
        }
        String p = x.group(4), q = y.group(4);
        if (p == null || q == null) return (p == null ? 0 : -1) + (q == null ? 0 : 1);
        String[] ps = p.split("\\."), qs = q.split("\\.");
        for (int i = 0; i < Math.max(ps.length, qs.length); i++) {
            if (i >= ps.length) return -1;
            if (i >= qs.length) return 1;
            boolean pn = ps[i].matches("\\d+"), qn = qs[i].matches("\\d+");
            if (pn && qn) {
                int c = Long.compare(Long.parseLong(ps[i]), Long.parseLong(qs[i]));
                if (c != 0) return c;
            } else if (pn) return -1;
            else if (qn) return 1;
            else {
                int c = ps[i].compareTo(qs[i]);
                if (c != 0) return c < 0 ? -1 : 1;
            }
        }
        return 0;
    }

    /**
     * {tag, file} for https://github.com/RELEASE_REPO/releases/download/TAG/FILE, {null, file} for
     * .../releases/latest/download/FILE, or null. No port, userinfo, query or fragment.
     */
    public static String[] releaseAsset(String url) {
        if (url == null || url.length() > 512) return null;
        try {
            URI u = new URI(url);
            if (!"https".equals(u.getScheme()) || !"github.com".equals(u.getHost()) || u.getPort() != -1 || u.getRawUserInfo() != null
                || u.getRawQuery() != null || u.getRawFragment() != null) return null;
            String path = u.getRawPath();
            if (path == null || path.contains("%")) return null;
            String[] parts = path.split("/", -1);
            String[] repo = RELEASE_REPO.toLowerCase(Locale.ROOT).split("/");
            if (parts.length != 7 || !parts[1].toLowerCase(Locale.ROOT).equals(repo[0]) || !parts[2].toLowerCase(Locale.ROOT).equals(repo[1]) || !parts[3].equals("releases")) return null;
            if (parts[4].equals("download") && segment(parts[5]) && segment(parts[6])) return new String[]{parts[5], parts[6]};
            if (parts[4].equals("latest") && parts[5].equals("download") && segment(parts[6])) return new String[]{null, parts[6]};
            return null;
        } catch (Exception malformed) {
            return null;
        }
    }

    private static boolean segment(String s) { return SEGMENT.matcher(s).matches() && !s.equals(".") && !s.equals(".."); }

    /** A release asset with a tag (installGame, openNative). */
    public static boolean isTaggedAsset(String url) {
        String[] a = releaseAsset(url);
        return a != null && a[0] != null;
    }

    /** update.fetch: a release asset, or the releases listing. */
    public static boolean isFetchUrl(String url) { return RELEASES_API.equals(url) || releaseAsset(url) != null; }

    /** A redirect target GitHub uses for release downloads (https, its asset hosts only). */
    public static boolean isAssetRedirect(String url) {
        try {
            URI u = new URI(url);
            return "https".equals(u.getScheme()) && u.getHost() != null && ASSET_REDIRECT_HOSTS.contains(u.getHost().toLowerCase(Locale.ROOT)) && u.getPort() == -1 && u.getRawUserInfo() == null;
        } catch (Exception malformed) {
            return false;
        }
    }

    /** Play listing for openNative (https://play.google.com only). */
    public static boolean isPlayUrl(String url) {
        try {
            URI u = new URI(url);
            return "https".equals(u.getScheme()) && "play.google.com".equals(u.getHost()) && u.getPort() == -1 && u.getRawUserInfo() == null;
        } catch (Exception malformed) {
            return false;
        }
    }

    /**
     * Whether a zip entry name is a safe relative path inside the bundle (zip-slip): no absolute path, drive letter,
     * backslash, NUL or control character, "." / ".." or empty segment, or over-long name.
     */
    public static boolean safeEntryName(String name) {
        if (name == null || name.isEmpty() || name.length() > 512 || name.startsWith("/") || name.matches("^[A-Za-z]:.*")) return false;
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            if (c == '\\' || c < 0x20 || c == 0x7f) return false;
        }
        String trimmed = name.endsWith("/") ? name.substring(0, name.length() - 1) : name;
        for (String part : trimmed.split("/", -1)) if (part.isEmpty() || part.equals(".") || part.equals("..")) return false;
        return true;
    }

    /** Development builds only: github.com and api.github.com URLs mapped to a loopback test server. */
    public static String fixtureUrl(String url, String fixtureOrigin) {
        try {
            URI u = new URI(url);
            String rest = u.getRawPath() + (u.getRawQuery() == null ? "" : "?" + u.getRawQuery());
            return "api.github.com".equals(u.getHost()) ? fixtureOrigin + "/api" + rest : fixtureOrigin + rest;
        } catch (Exception malformed) {
            return null;
        }
    }

    // ---- bundle state machine (the files themselves are GameUpdater's) ------------------------------------------

    /** Answers whether an installed bundle folder exists with the right game-version.json. */
    public interface Usable { boolean test(String version); }

    /** Persisted state; GameUpdater stores it as JSON. */
    public static final class State {
        public String active, knownGood, pending, trialVersion;
        public long trialStartedAt;
        public final List<String> bad = new ArrayList<>();
    }

    /** A bundle may be served only if it is usable and newer than the game built into the app. */
    public static boolean servable(String version, String builtin, Usable usable) {
        return version != null && usable.test(version) && (builtin == null || compare(version, builtin) > 0);
    }

    /** Rolls back the trial (or active) bundle. Returns the version given up. */
    public static String rollback(State s, String builtin, Usable usable) {
        String failed = s.trialVersion != null ? s.trialVersion : s.active;
        if (failed != null && !s.bad.contains(failed)) s.bad.add(failed);
        while (s.bad.size() > 20) s.bad.remove(0);
        s.trialVersion = null;
        s.trialStartedAt = 0;
        s.active = servable(s.knownGood, builtin, usable) ? s.knownGood : null;
        return failed;
    }

    /** At app start: an unfinished trial rolls back; a pending bundle becomes the trial. Returns the rolled-back version or null. */
    public static String launch(State s, String builtin, Usable usable, long now) {
        String rolledBack = s.trialVersion != null ? rollback(s, builtin, usable) : null;
        if (servable(s.pending, builtin, usable)) {
            s.trialVersion = s.pending;
            s.trialStartedAt = now;
            s.active = s.pending;
        }
        s.pending = null;
        if (s.active != null && !servable(s.active, builtin, usable)) s.active = servable(s.knownGood, builtin, usable) ? s.knownGood : null;
        return rolledBack;
    }

    public static boolean activate(State s, String builtin, Usable usable, long now) {
        if (!servable(s.pending, builtin, usable)) return false;
        s.trialVersion = s.pending;
        s.trialStartedAt = now;
        s.active = s.pending;
        s.pending = null;
        return true;
    }

    public static void bootOk(State s) {
        s.trialVersion = null;
        s.trialStartedAt = 0;
        s.knownGood = s.active;
    }

    /** True when the trial has run BOOT_TIMEOUT_MS without bootOk. */
    public static boolean trialExpired(State s, long now) {
        return s.trialVersion != null && now - s.trialStartedAt >= BOOT_TIMEOUT_MS;
    }

    /** Why `version` can't be installed (forward only; never one that failed to boot), or null. */
    public static String refuse(State s, String builtin, String version) {
        if (!isSemver(version)) return "Malformed version.";
        for (String v : new String[]{s.active, s.pending, s.knownGood, builtin})
            if (v != null && isSemver(v) && compare(version, v) <= 0) return "Version " + version + " is not newer than what this app has.";
        if (s.bad.contains(version)) return "Version " + version + " failed to start before, so it is not installed again.";
        return null;
    }
}
