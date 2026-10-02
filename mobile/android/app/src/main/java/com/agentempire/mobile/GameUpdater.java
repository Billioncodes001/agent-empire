package com.agentempire.mobile;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * In-app updates for the Android shell (docs/team/RELEASE_PLAN.md, REL-04). Rules live in UpdatePolicy (unit-tested);
 * this class does the files, downloads and the system installer. All methods except the getters run on a background
 * thread (NativeBridge's io executor).
 *
 * Bundles: files/game-bundles/<version>/ (a copy of the game zip), state in files/game-bundles/state.json written
 * atomically. GameAssets serves the active folder; the APK's assets/game stays the final fallback.
 */
final class GameUpdater {
    private static final String TAG = "AgentEmpire";
    static final String INSTALL_ACTION = "com.agentempire.mobile.INSTALL_STATUS";

    private final Activity activity;
    private final File root;
    private final File statePath;
    private final String builtinVersion;
    private final boolean debuggable;
    /** Debug builds only: a loopback stand-in for GitHub releases (intent extra ae.debug.updates). */
    volatile String fixtureOrigin;
    private UpdatePolicy.State state;
    private String rolledBack;
    private volatile boolean installing;

    GameUpdater(Activity activity, boolean debuggable) {
        this.activity = activity;
        this.debuggable = debuggable;
        this.root = new File(activity.getFilesDir(), "game-bundles");
        //noinspection ResultOfMethodCallIgnored
        root.mkdirs();
        this.statePath = new File(root, "state.json");
        this.builtinVersion = readBuiltinVersion(activity.getAssets());
        this.state = load();
    }

    private final UpdatePolicy.Usable usable = new UpdatePolicy.Usable() {
        @Override public boolean test(String version) {
            if (version == null || !UpdatePolicy.isSemver(version)) return false;
            File dir = new File(root, version);
            return new File(dir, "index.html").isFile() && version.equals(versionOf(new File(dir, "game-version.json")));
        }
    };

    String builtinVersion() { return builtinVersion; }

    // ---- state ------------------------------------------------------------------------------------------------

    private UpdatePolicy.State load() {
        UpdatePolicy.State s = new UpdatePolicy.State();
        try {
            JSONObject o = new JSONObject(new String(readAll(new FileInputStream(statePath), 64 * 1024), StandardCharsets.UTF_8));
            s.active = version(o.optString("active", null));
            s.knownGood = version(o.optString("knownGood", null));
            s.pending = version(o.optString("pending", null));
            s.trialVersion = version(o.optString("trialVersion", null));
            s.trialStartedAt = o.optLong("trialStartedAt", 0);
            JSONArray bad = o.optJSONArray("bad");
            if (bad != null) for (int i = 0; i < bad.length(); i++) if (UpdatePolicy.isSemver(bad.optString(i))) s.bad.add(bad.optString(i));
        } catch (Exception missingOrDamaged) {
            // A fresh install, or a damaged file: start from the built-in game.
        }
        return s;
    }

    private static String version(String v) { return UpdatePolicy.isSemver(v) ? v : null; }

    private synchronized void save() throws IOException {
        JSONObject o = new JSONObject();
        try {
            o.put("active", state.active == null ? JSONObject.NULL : state.active);
            o.put("knownGood", state.knownGood == null ? JSONObject.NULL : state.knownGood);
            o.put("pending", state.pending == null ? JSONObject.NULL : state.pending);
            o.put("trialVersion", state.trialVersion == null ? JSONObject.NULL : state.trialVersion);
            o.put("trialStartedAt", state.trialStartedAt);
            o.put("bad", new JSONArray(state.bad));
        } catch (Exception impossible) {
            throw new IOException("state");
        }
        File tmp = new File(root, "state.json." + UUID.randomUUID() + ".tmp");
        try (OutputStream out = new FileOutputStream(tmp)) {
            out.write(o.toString().getBytes(StandardCharsets.UTF_8));
        }
        if (!tmp.renameTo(statePath)) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            throw new IOException("Could not save the update state.");
        }
    }

    /** At app start, before the game loads. Returns true when a trial is running (the caller arms the 20 s timer). */
    synchronized boolean launch(long now) {
        String back = UpdatePolicy.launch(state, builtinVersion, usable, now);
        if (back != null) {
            rolledBack = back;
            Log.w(TAG, "Game update " + back + " never reported booting; rolled back");
        }
        trySave();
        return state.trialVersion != null;
    }

    /** The folder GameAssets serves now, or null for the built-in assets/game. */
    synchronized File activeRoot() {
        return UpdatePolicy.servable(state.active, builtinVersion, usable) ? new File(root, state.active) : null;
    }

    synchronized String installedGame() {
        return UpdatePolicy.servable(state.active, builtinVersion, usable) ? state.active : builtinVersion;
    }

    synchronized String pendingGame() { return state.pending; }

    synchronized String takeRolledBack() {
        String v = rolledBack;
        rolledBack = null;
        return v;
    }

    synchronized boolean activate(long now) {
        if (!UpdatePolicy.activate(state, builtinVersion, usable, now)) return false;
        trySave();
        return true;
    }

    synchronized void bootOk() {
        UpdatePolicy.bootOk(state);
        trySave();
        cleanup();
    }

    /** Called by the 20 s timer. True when it rolled back (the caller reloads the game). */
    synchronized boolean checkTrial(long now) {
        if (!UpdatePolicy.trialExpired(state, now)) return false;
        rolledBack = UpdatePolicy.rollback(state, builtinVersion, usable);
        trySave();
        return true;
    }

    synchronized long trialRemaining(long now) {
        return state.trialVersion == null ? -1 : Math.max(0, state.trialStartedAt + UpdatePolicy.BOOT_TIMEOUT_MS - now);
    }

    private void trySave() {
        try {
            save();
        } catch (IOException error) {
            Log.w(TAG, "Update state not saved: " + error.getMessage());
        }
    }

    private void cleanup() {
        Set<String> keep = new HashSet<>();
        for (String v : new String[]{state.active, state.knownGood, state.pending}) if (v != null) keep.add(v);
        File[] files = root.listFiles();
        if (files == null) return;
        for (File f : files) {
            String name = f.getName();
            if (name.equals("state.json") || keep.contains(name)) continue;
            if (UpdatePolicy.isSemver(name) || (name.startsWith(".tmp-") && !installing) || name.endsWith(".apk")) deleteTree(f);
        }
    }

    // ---- downloads ----------------------------------------------------------------------------------------------

    static final class Fetched {
        final int status;
        final byte[] body;
        final String etag;
        Fetched(int status, byte[] body, String etag) { this.status = status; this.body = body; this.etag = etag; }
    }

    /**
     * GET following redirects by hand: the first URL must be a release URL, each redirect must stay on GitHub's asset
     * hosts (or, in a debug build with a fixture, on the fixture origin). Streams to `sink` when given.
     */
    Fetched fetch(String url, String etag, long maxBytes, OutputStream sink) throws IOException {
        if (!UpdatePolicy.isFetchUrl(url)) throw new IOException("That address is not an Agent Empire release.");
        // The loopback fixture only in a debuggable build that still pins the development key.
        String fixture = debuggable && UpdatePolicy.RELEASE_KEY_IS_DEVELOPMENT ? fixtureOrigin : null;
        String current = fixture != null ? UpdatePolicy.fixtureUrl(url, fixture) : url;
        for (int hop = 0; hop <= 5; hop++) {
            HttpURLConnection c = (HttpURLConnection) new URL(current).openConnection();
            try {
                c.setInstanceFollowRedirects(false);
                c.setConnectTimeout(20_000);
                c.setReadTimeout(60_000);
                c.setRequestProperty("User-Agent", "AgentEmpire-Android");
                c.setRequestProperty("Accept", url.startsWith("https://api.github.com/") ? "application/vnd.github+json" : "application/octet-stream");
                if (etag != null && hop == 0) c.setRequestProperty("If-None-Match", etag);
                int status = c.getResponseCode();
                if (status >= 300 && status < 400 && status != 304) {
                    String location = c.getHeaderField("Location");
                    if (location == null) throw new IOException("GitHub sent a redirect without a location.");
                    String next = new URI(current).resolve(location).toString();
                    boolean allowed = fixture != null ? next.startsWith(fixture + "/") : UpdatePolicy.isAssetRedirect(next) || UpdatePolicy.releaseAsset(next) != null;
                    if (!allowed) throw new IOException("The download was redirected somewhere unexpected.");
                    current = next;
                    continue;
                }
                long declared = c.getContentLengthLong();
                if (declared > maxBytes) throw new IOException("The download is too large.");
                InputStream in = status >= 400 ? c.getErrorStream() : status == 304 ? null : c.getInputStream();
                byte[] body = new byte[0];
                if (in != null) {
                    if (sink != null && status == 200) copy(in, sink, maxBytes);
                    else body = readAll(in, maxBytes);
                }
                return new Fetched(status, body, c.getHeaderField("ETag"));
            } catch (java.net.URISyntaxException bad) {
                throw new IOException("Malformed redirect.");
            } finally {
                c.disconnect();
            }
        }
        throw new IOException("Too many redirects.");
    }

    // ---- game bundles -------------------------------------------------------------------------------------------

    /** Downloads, verifies (sha256 from the signed channel), unpacks and marks pending. */
    String installGame(String url, String sha256, String version) throws IOException {
        if (!UpdatePolicy.isTaggedAsset(url) || !UpdatePolicy.isSha256(sha256)) throw new IOException("That update is not an Agent Empire release.");
        synchronized (this) {
            String refused = UpdatePolicy.refuse(state, builtinVersion, version);
            if (refused != null) throw new IOException(refused);
            if (installing) throw new IOException("An update is already being installed.");
            installing = true;
        }
        File zip = new File(root, ".tmp-" + version + "-" + UUID.randomUUID() + ".zip");
        File tmp = new File(root, ".tmp-" + version + "-" + UUID.randomUUID());
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (OutputStream out = new java.security.DigestOutputStream(new FileOutputStream(zip), digest)) {
                Fetched r = fetch(url, null, UpdatePolicy.MAX_ZIP_BYTES, out);
                if (r.status != 200) throw new IOException("GitHub answered " + r.status + " for the update.");
            }
            if (!hex(digest.digest()).equals(sha256)) throw new IOException("The download does not match the signed release (sha256). Nothing was installed.");
            unzip(zip, tmp);
            if (!new File(tmp, "index.html").isFile()) throw new IOException("The update has no game in it.");
            if (!version.equals(versionOf(new File(tmp, "game-version.json")))) throw new IOException("The update's files are for a different version.");
            File dest = new File(root, version);
            deleteTree(dest);
            if (!tmp.renameTo(dest)) throw new IOException("The update could not be put in place.");
            synchronized (this) {
                String again = UpdatePolicy.refuse(state, builtinVersion, version);
                if (again != null) throw new IOException(again);
                state.pending = version;
                save();
            }
            return version;
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IOException("SHA-256 is unavailable.");
        } finally {
            installing = false;
            //noinspection ResultOfMethodCallIgnored
            zip.delete();
            deleteTree(tmp);
        }
    }

    /** Unpacks with zip-slip protection: every name is checked, and every target must stay inside `dest`. */
    static void unzip(File zip, File dest) throws IOException {
        if (!dest.mkdirs()) throw new IOException("Could not create the update folder.");
        String base = dest.getCanonicalPath() + File.separator;
        long total = 0;
        int count = 0;
        Set<String> seen = new HashSet<>();
        try (ZipInputStream in = new ZipInputStream(new FileInputStream(zip))) {
            ZipEntry e;
            byte[] buffer = new byte[65536];
            while ((e = in.getNextEntry()) != null) {
                String name = e.getName();
                if (!UpdatePolicy.safeEntryName(name)) throw new IOException("Unsafe path in the archive: " + name);
                if (++count > UpdatePolicy.MAX_ENTRIES) throw new IOException("The archive has too many files.");
                String key = (name.endsWith("/") ? name.substring(0, name.length() - 1) : name).toLowerCase(java.util.Locale.ROOT);
                if (!seen.add(key)) throw new IOException("The archive lists " + name + " twice.");
                File target = new File(dest, name);
                if (!target.getCanonicalPath().startsWith(base)) throw new IOException("Unsafe path in the archive: " + name);
                if (e.isDirectory()) {
                    //noinspection ResultOfMethodCallIgnored
                    target.mkdirs();
                    continue;
                }
                File parent = target.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("Could not unpack " + name);
                if (target.exists()) throw new IOException("The archive lists " + name + " twice.");
                try (OutputStream out = new FileOutputStream(target)) {
                    int n;
                    while ((n = in.read(buffer)) != -1) {
                        total += n;
                        if (total > UpdatePolicy.MAX_UNPACKED_BYTES) throw new IOException("The archive is too large once unpacked.");
                        out.write(buffer, 0, n);
                    }
                }
            }
        }
        if (count == 0) throw new IOException("The update is empty.");
    }

    // ---- native app update (sideload APK or Play) ------------------------------------------------------------

    /** "play" when Google Play installed this app, else "sideload". */
    String installSource() {
        try {
            String installer = Build.VERSION.SDK_INT >= 30
                ? activity.getPackageManager().getInstallSourceInfo(activity.getPackageName()).getInstallingPackageName()
                : activity.getPackageManager().getInstallerPackageName(activity.getPackageName());
            return "com.android.vending".equals(installer) ? "play" : "sideload";
        } catch (Exception unknown) {
            return "sideload";
        }
    }

    String shellVersion() {
        try {
            PackageInfo info = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0);
            return info.versionName;
        } catch (PackageManager.NameNotFoundException impossible) {
            return null;
        }
    }

    /**
     * Sideloaded app: downloads the APK, checks its sha256 against the signed channel and hands it to the system
     * installer (the user confirms; Android refuses an APK signed with another key). Returns "installer", or
     * "permission" after opening the "install unknown apps" setting when this app may not install yet.
     */
    String installApk(String url, String sha256) throws IOException {
        if (!UpdatePolicy.isTaggedAsset(url) || !UpdatePolicy.isSha256(sha256)) throw new IOException("That download is not an Agent Empire release.");
        if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.getPackageName()));
            activity.runOnUiThread(() -> activity.startActivity(settings));
            return "permission";
        }
        File apk = new File(root, "update-" + UUID.randomUUID() + ".apk");
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (OutputStream out = new java.security.DigestOutputStream(new FileOutputStream(apk), digest)) {
                Fetched r = fetch(url, null, UpdatePolicy.MAX_APK_BYTES, out);
                if (r.status != 200) throw new IOException("GitHub answered " + r.status + " for the app.");
            }
            if (!hex(digest.digest()).equals(sha256)) throw new IOException("The app download does not match the signed release (sha256). Nothing was installed.");
            PackageInstaller installer = activity.getPackageManager().getPackageInstaller();
            PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            params.setAppPackageName(activity.getPackageName());
            int id = installer.createSession(params);
            try (PackageInstaller.Session session = installer.openSession(id)) {
                try (OutputStream out = session.openWrite("agent-empire.apk", 0, apk.length()); InputStream in = new FileInputStream(apk)) {
                    copy(in, out, UpdatePolicy.MAX_APK_BYTES);
                    session.fsync(out);
                }
                Intent status = new Intent(INSTALL_ACTION).setPackage(activity.getPackageName()).setClass(activity, MainActivity.class);
                int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                session.commit(PendingIntent.getActivity(activity, id, status, flags).getIntentSender());
            }
            return "installer";
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IOException("SHA-256 is unavailable.");
        } finally {
            //noinspection ResultOfMethodCallIgnored
            apk.delete();
        }
    }

    // ---- helpers ------------------------------------------------------------------------------------------------

    static String readBuiltinVersion(AssetManager assets) {
        try (InputStream in = assets.open("game/game-version.json")) {
            return version(new JSONObject(new String(readAll(in, 4096), StandardCharsets.UTF_8)).optString("version", null));
        } catch (Exception missing) {
            return null;
        }
    }

    static String versionOf(File file) {
        try (InputStream in = new FileInputStream(file)) {
            return version(new JSONObject(new String(readAll(in, 4096), StandardCharsets.UTF_8)).optString("version", null));
        } catch (Exception missing) {
            return null;
        }
    }

    static byte[] readAll(InputStream in, long max) throws IOException {
        try (InputStream stream = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            copy(stream, out, max);
            return out.toByteArray();
        }
    }

    static void copy(InputStream in, OutputStream out, long max) throws IOException {
        byte[] buffer = new byte[65536];
        long total = 0;
        int n;
        while ((n = in.read(buffer)) != -1) {
            total += n;
            if (total > max) throw new IOException("The download is too large.");
            out.write(buffer, 0, n);
        }
    }

    static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder();
        for (byte b : bytes) out.append(String.format("%02x", b));
        return out.toString();
    }

    static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] children = f.isDirectory() && !isSymlink(f) ? f.listFiles() : null;
        if (children != null) for (File c : children) deleteTree(c);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private static boolean isSymlink(File f) {
        return java.nio.file.Files.isSymbolicLink(f.toPath());
    }
}
