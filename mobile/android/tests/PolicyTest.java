package com.agentempire.mobile;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Desktop JVM checks for the Android shell's pure policies (run by mobile/tools/build-android.py before packaging).
 * Optional argument: the staged game folder (dist/public); every shipped file must be reachable with a real MIME type.
 */
public final class PolicyTest {
    private static int checks;

    public static void main(String[] args) throws Exception {
        origin();
        assetPaths();
        mime();
        injection();
        server();
        bridge();
        updates();
        if (args.length > 0) bundle(Paths.get(args[0]));
        System.out.println("PolicyTest: " + checks + " checks passed (origin, asset paths/traversal, MIME, config injection, server address, bridge rules, in-app updates"
            + (args.length > 0 ? ", every bundled file" : "") + ")");
    }

    private static void origin() {
        for (String ok : new String[]{"https://appassets.androidplatform.net/", "https://appassets.androidplatform.net", "https://APPASSETS.androidplatform.net/x?y#z",
            "https://appassets.androidplatform.net:443/index.html"}) check(AssetPolicy.isAppOrigin(ok), "origin ok: " + ok);
        for (String bad : new String[]{null, "", "http://appassets.androidplatform.net/", "https://appassets.androidplatform.net.evil.test/",
            "https://evil.test/https://appassets.androidplatform.net/", "https://user@appassets.androidplatform.net/", "https://appassets.androidplatform.net:444/",
            "https://appassets.androidplatform.net@evil.test/", "file:///android_asset/game/index.html", "javascript:alert(1)", "about:blank",
            "data:text/html,x", "https://androidplatform.net/", "https://evil.appassets.androidplatform.net/", "https://appassets.androidplatform.net./",
            "intent://appassets.androidplatform.net/#Intent;end", "https://appassets.androidplatform.net\\@evil.test/"})
            check(!AssetPolicy.isAppOrigin(bad), "origin rejected: " + bad);
    }

    private static void assetPaths() {
        eq(AssetPolicy.assetPath("/"), "game/index.html");
        eq(AssetPolicy.assetPath("/index.html"), "game/index.html");
        eq(AssetPolicy.assetPath("/assets/main-D9Amp3ne.js"), "game/assets/main-D9Amp3ne.js");
        eq(AssetPolicy.assetPath("/audio/door%20open.wav"), "game/audio/door open.wav");
        eq(AssetPolicy.assetPath("/models/a+b.glb"), "game/models/a+b.glb");
        for (String bad : new String[]{null, "", "index.html", "/..", "/../secret", "/assets/../../x", "/assets/%2e%2e/x", "/%2E%2E/x", "/assets/.", "/./index.html",
            "/assets//x.js", "/assets/", "/.env", "/assets/.hidden", "/a%2Fb", "/a%2fb", "/a%5Cb", "/a\\b", "/a%00b", "/a%zzb", "/a%2", "/a%",
            "/a%C3%28", "/é", "/a\nb", "/a:b", "/a?b", "/a#b", "/a%3Fb", "/a%23b", "/a*b", "/a<b", "/" + repeat("x", 600)})
            check(AssetPolicy.assetPath(bad) == null, "path rejected: " + bad);
    }

    private static void mime() {
        String[][] table = {{"game/index.html", "text/html"}, {"game/assets/main.js", "text/javascript"}, {"game/assets/main.css", "text/css"},
            {"game/manifest.webmanifest", "application/manifest+json"}, {"game/a.glb", "model/gltf-binary"}, {"game/a.wasm", "application/wasm"},
            {"game/a.WAV", "audio/wav"}, {"game/a.jpg", "image/jpeg"}, {"game/a.svg", "image/svg+xml"}, {"game/a.woff2", "font/woff2"},
            {"game/a.hdr", "application/octet-stream"}, {"game/a.unknownext", "application/octet-stream"}, {"game/noext", "application/octet-stream"},
            {"game/dir.v2/noext", "application/octet-stream"}, {"game/a.json", "application/json"}, {"game/a.png", "image/png"}, {"game/a.webp", "image/webp"}};
        for (String[] row : table) eq(AssetPolicy.mimeType(row[0]), row[1]);
        check(AssetPolicy.isText("text/html") && AssetPolicy.isText("application/json") && !AssetPolicy.isText("model/gltf-binary"), "text types");
    }

    private static void injection() {
        String tag = "<script src=\"/__agent-empire/app-config.js\"></script>";
        eq(AssetPolicy.injectConfigScript("<!doctype html><html><head><meta charset=utf-8><script type=module src=/m.js></script></head>"),
            "<!doctype html><html><head>" + tag + "<meta charset=utf-8><script type=module src=/m.js></script></head>");
        eq(AssetPolicy.injectConfigScript("<HTML><HEAD lang=en>x"), "<HTML><HEAD lang=en>" + tag + "x");
        eq(AssetPolicy.injectConfigScript("<html><header>h</header><head>x"), "<html><header>h</header><head>" + tag + "x");
        check(AssetPolicy.injectConfigScript("<html><body>no head</body></html>") == null, "no head refused");
        check(AssetPolicy.CONFIG_PATH.startsWith("/__") && AssetPolicy.assetPath(AssetPolicy.CONFIG_PATH) != null
            && AssetPolicy.assetPath(AssetPolicy.CONFIG_PATH).startsWith("game/__"), "config path is synthetic, never shadowed by a hidden file");
    }

    private static void server() {
        eq(ServerPolicy.normalise(" https://City.Example:443/ ", false), "https://city.example");
        eq(ServerPolicy.normalise("https://city.example:8443", false), "https://city.example:8443");
        eq(ServerPolicy.normalise("http://10.0.2.2:4706", true), "http://10.0.2.2:4706");
        eq(ServerPolicy.normalise("http://127.0.0.1:80/", true), "http://127.0.0.1");
        for (String bad : new String[]{null, "http://city.example", "http://10.0.2.2:4706", "javascript:alert(1)", "file:///tmp/index.html", "https://user:token@city.example",
            "https://city.example/?token=x", "https://city.example/#secret", "https://city.example/login", "https://city.example:0", "https://city.example:65536",
            "//city.example", "https://city.example\\@other.example", "ws://city.example"})
            check(!ServerPolicy.isValid(bad, false), "release server rejected: " + bad);
        for (String bad : new String[]{"http://city.example", "http://10.0.2.3", "http://192.168.1.2:4706", "http://localhost.evil.test", "http://127.0.0.1.nip.io"})
            check(!ServerPolicy.isValid(bad, true), "debug server rejected: " + bad);
    }

    private static void bridge() {
        List<String> keys = Arrays.asList("mode", "server.host", "server.token", "server.deviceId", "github.token", "github.login", "state.repo");
        eq(BridgePolicy.KEYS.toString(), keys.toString());
        for (String key : keys) check(BridgePolicy.isKey(key), "key " + key);
        for (String bad : new String[]{null, "", "Mode", "server.password", "openai.key", "anthropic.key", "github.token ", "__proto__", "server"})
            check(!BridgePolicy.isKey(bad), "key rejected: " + bad);
        check(BridgePolicy.KEYS.containsAll(BridgePolicy.SESSION_KEYS) && !BridgePolicy.SESSION_KEYS.contains("mode") && !BridgePolicy.SESSION_KEYS.contains("server.host")
            && BridgePolicy.SESSION_KEYS.contains("server.token") && BridgePolicy.SESSION_KEYS.contains("github.token"), "session keys");
        eq(String.join(",", BridgePolicy.METHODS.stream().sorted().collect(Collectors.toList())),
            "app.openExternal,app.signedOut,github.deviceFlow,secure.delete,secure.get,secure.set,update.activate,update.bootOk,update.fetch,update.installGame,update.nativeInfo,update.openNative");
        for (String bad : new String[]{null, "secure.list", "eval", "app.exit", "github.token"}) check(!BridgePolicy.isMethod(bad), "method rejected: " + bad);
        check(BridgePolicy.isRequestId("42") && BridgePolicy.isRequestId("req-1:a.b") && !BridgePolicy.isRequestId("a'b") && !BridgePolicy.isRequestId("x);alert(1") && !BridgePolicy.isRequestId(""), "ids");
        check(BridgePolicy.isClientId("Ov23li3G3aR4rgZ0lCJ3") && !BridgePolicy.isClientId("a b") && !BridgePolicy.isClientId("x&scope=admin"), "client ids");
        eq(BridgePolicy.scopes(Arrays.asList("repo", "workflow", "read:user")), "repo workflow read:user");
        eq(BridgePolicy.scopes(Arrays.asList("repo", "workflow", "repo")), "repo workflow");
        check(BridgePolicy.scopes(Arrays.<String>asList()) == null, "no scopes refused (iOS parity)");
        for (String bad : new String[]{"admin:org", "delete_repo", "user", "write:packages", "admin:repo_hook", "gist", "Repo", "repo:status"})
            check(BridgePolicy.scopes(Arrays.asList("repo", bad)) == null, "scope outside {repo, workflow, read:user} refused: " + bad);
        check(BridgePolicy.scopes(Arrays.asList("repo", "a b")) == null && BridgePolicy.scopes(Arrays.asList("repo&x=1")) == null && BridgePolicy.scopes(null) == null
            && BridgePolicy.scopes(Arrays.asList("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k")) == null && BridgePolicy.scopes(Arrays.asList((String) null)) == null, "scopes rejected");
        check(BridgePolicy.isValue(repeat("x", 8192)) && !BridgePolicy.isValue(repeat("x", 8193)) && !BridgePolicy.isValue(null), "value length");
        check(BridgePolicy.externalUrl("https://github.com/login/device") != null && BridgePolicy.externalUrl("https://github.com/o/r/pull/1?x=1#y") != null, "external ok");
        for (String bad : new String[]{null, "http://github.com", "javascript:alert(1)", "intent://x#Intent;end", "file:///sdcard/x", "https://user:pw@github.com/",
            "https://appassets.androidplatform.net/", "content://x", "market://details?id=x", "https:///nohost", "data:text/html,x"})
            check(BridgePolicy.externalUrl(bad) == null, "external rejected: " + bad);
        check(BridgePolicy.isVerificationUrl("https://github.com/login/device", "https://github.com"), "verification ok");
        check(BridgePolicy.isVerificationUrl("http://10.0.2.2:4707/login/device", "http://10.0.2.2:4707"), "debug verification ok");
        for (String bad : new String[]{"https://github.com.evil.test/login/device", "http://github.com/login/device", "https://evil.test/", "https://user@github.com/", null})
            check(!BridgePolicy.isVerificationUrl(bad, "https://github.com"), "verification rejected: " + bad);
        check(BridgePolicy.gestureAllows(1000, 1000) && BridgePolicy.gestureAllows(1000, 6000) && !BridgePolicy.gestureAllows(1000, 6001)
            && !BridgePolicy.gestureAllows(0, 10) && !BridgePolicy.gestureAllows(1000, 999), "gesture window");
        check(BridgePolicy.isDeviceToken("abcdefghijklmnop_-") && !BridgePolicy.isDeviceToken("short") && !BridgePolicy.isDeviceToken("has space in the token"), "device token shape");
        valueRules();
        config();
        check(BridgePolicy.SESSION_KEYS.toString().equals("[server.token, server.deviceId, github.token, github.login]"), "session keys: the same set iOS clears");
        check(AssetPolicy.htmlHeaders().get("Content-Security-Policy").equals(AssetPolicy.HTML_CSP) && AssetPolicy.HTML_CSP.contains("frame-src 'self'")
            && AssetPolicy.HTML_CSP.contains("object-src 'none'") && !AssetPolicy.HTML_CSP.contains("*"), "every HTML response carries the CSP that keeps foreign frames out");
    }

    /** In-app updates (REL-04): URLs, versions, zip-slip names and the bundle state machine with its 20 s rollback. */
    private static void updates() throws Exception {
        String repo = "https://github.com/" + UpdatePolicy.RELEASE_REPO;
        check(UpdatePolicy.RELEASE_PUBLIC_KEY.length() == 44 && UpdatePolicy.RELEASE_KEY_IS_DEVELOPMENT, "dev release key pinned (same string as src/shared/release-key.ts)");
        String[] a = UpdatePolicy.releaseAsset(repo + "/releases/download/v1.0.0-beta.2/agent-empire-game-1.0.0-beta.2.zip");
        check(a != null && a[0].equals("v1.0.0-beta.2") && a[1].equals("agent-empire-game-1.0.0-beta.2.zip"), "release asset parsed");
        check(UpdatePolicy.releaseAsset(repo + "/releases/latest/download/channel-stable.json")[0] == null, "latest asset");
        check(UpdatePolicy.isFetchUrl(UpdatePolicy.RELEASES_API) && !UpdatePolicy.isFetchUrl("https://api.github.com/user"), "fetch urls");
        for (String bad : new String[]{null, "https://evil.test/a.zip", repo.replace("Billioncodes001", "evil") + "/releases/download/v1/a.zip", repo + "/releases/download/../a.zip",
            repo + "/releases/download/v1/%2e%2e", repo + "/releases/download/v1/a.zip?x=1", "http://github.com/" + UpdatePolicy.RELEASE_REPO + "/releases/download/v1/a.zip",
            "https://github.com:444/" + UpdatePolicy.RELEASE_REPO + "/releases/download/v1/a.zip", "https://u@github.com/" + UpdatePolicy.RELEASE_REPO + "/releases/download/v1/a.zip",
            repo + "/archive/v1.zip", repo + "/releases/download/v1/a/b.zip"})
            check(UpdatePolicy.releaseAsset(bad) == null && !UpdatePolicy.isTaggedAsset(bad), "release asset rejected: " + bad);
        check(UpdatePolicy.isAssetRedirect("https://release-assets.githubusercontent.com/x?sig=1") && UpdatePolicy.isAssetRedirect("https://objects.githubusercontent.com/y")
            && !UpdatePolicy.isAssetRedirect("http://objects.githubusercontent.com/y") && !UpdatePolicy.isAssetRedirect("https://evil.test/y")
            && !UpdatePolicy.isAssetRedirect("https://objects.githubusercontent.com.evil.test/y"), "redirect hosts");
        check(UpdatePolicy.isPlayUrl("https://play.google.com/store/apps/details?id=com.agentempire.mobile") && !UpdatePolicy.isPlayUrl("https://evil.test/x"), "play links");
        String[] order = {"0.1.0", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.10", "1.0.0-rc.1", "1.0.0", "1.0.1", "2.0.0"};
        for (int i = 0; i < order.length - 1; i++) check(UpdatePolicy.compare(order[i], order[i + 1]) < 0, order[i] + " < " + order[i + 1]);
        for (String bad : new String[]{"1.0", "v1.0.0", "01.0.0", "1.0.0-", "1.0.0+b", ""}) check(!UpdatePolicy.isSemver(bad), "not a version: " + bad);
        check(UpdatePolicy.isSha256(repeat("a", 64)) && !UpdatePolicy.isSha256(repeat("A", 64)) && !UpdatePolicy.isSha256("abc"), "sha256 shape");
        for (String ok : new String[]{"index.html", "assets/main.js", "assets/", "a b/c+d.glb"}) check(UpdatePolicy.safeEntryName(ok), "zip name ok: " + ok);
        for (String bad : new String[]{null, "", "../x", "a/../../x", "/etc/passwd", "C:/x", "a\\b", "a\u0000b", "a//b", "./x", "a/./b", repeat("x", 600)})
            check(!UpdatePolicy.safeEntryName(bad), "zip name refused: " + bad);
        check(UpdatePolicy.fixtureUrl(UpdatePolicy.RELEASES_API, "http://10.0.2.2:4719").equals("http://10.0.2.2:4719/api/repos/" + UpdatePolicy.RELEASE_REPO + "/releases?per_page=20"), "fixture mapping");

        // Bundle state machine.
        java.util.Set<String> present = new java.util.HashSet<>(Arrays.asList("1.0.0-beta.2", "1.0.0-beta.3"));
        UpdatePolicy.Usable usable = present::contains;
        String builtin = "1.0.0-beta.1";
        UpdatePolicy.State s = new UpdatePolicy.State();
        check(UpdatePolicy.refuse(s, builtin, "1.0.0-beta.1") != null && UpdatePolicy.refuse(s, builtin, "0.9.0") != null && UpdatePolicy.refuse(s, builtin, "1.0.0-beta.2") == null, "forward only");
        s.pending = "1.0.0-beta.2";
        check(UpdatePolicy.refuse(s, builtin, "1.0.0-beta.2") != null, "already pending");
        check(UpdatePolicy.launch(s, builtin, usable, 1000) == null && "1.0.0-beta.2".equals(s.active) && "1.0.0-beta.2".equals(s.trialVersion) && s.pending == null, "pending becomes a trial at launch");
        check(!UpdatePolicy.trialExpired(s, 1000 + 19_999) && UpdatePolicy.trialExpired(s, 1000 + 20_000), "20 s boot window");
        UpdatePolicy.bootOk(s);
        check("1.0.0-beta.2".equals(s.knownGood) && s.trialVersion == null, "bootOk makes it known-good");
        s.pending = "1.0.0-beta.3";
        check(UpdatePolicy.activate(s, builtin, usable, 5000) && "1.0.0-beta.3".equals(s.active), "activate starts the trial now");
        check(UpdatePolicy.trialExpired(s, 25_000), "no boot report in 20 s");
        check("1.0.0-beta.3".equals(UpdatePolicy.rollback(s, builtin, usable)) && "1.0.0-beta.2".equals(s.active) && s.bad.contains("1.0.0-beta.3"), "rolled back to known-good");
        check(UpdatePolicy.refuse(s, builtin, "1.0.0-beta.3") != null, "a failed version is never installed again");
        UpdatePolicy.State crash = new UpdatePolicy.State();
        crash.active = "1.0.0-beta.2";
        crash.trialVersion = "1.0.0-beta.2";
        check("1.0.0-beta.2".equals(UpdatePolicy.launch(crash, builtin, usable, 9000)) && crash.active == null, "an unfinished trial at launch rolls back to the built-in game");
        UpdatePolicy.State newer = new UpdatePolicy.State();
        newer.active = "1.0.0-beta.2";
        newer.knownGood = "1.0.0-beta.2";
        UpdatePolicy.launch(newer, "1.0.0", usable, 1);
        check(newer.active == null, "a newer built-in game wins over an older installed bundle");
        UpdatePolicy.State missing = new UpdatePolicy.State();
        missing.active = "1.0.0-beta.9";
        UpdatePolicy.launch(missing, builtin, usable, 1);
        check(missing.active == null, "a missing bundle folder falls back to the built-in game");
    }

    /** secure.set per-key rules, the same as iOS BridgeProtocol.validate. */
    private static void valueRules() {
        String[][] ok = {{"mode", "cloud"}, {"mode", "server"}, {"server.host", "https://city.example.com"}, {"server.host", "https://city.example.com:8443"},
            {"server.token", repeat("a", 43)}, {"server.deviceId", "dev_1"}, {"github.token", "gho_abc"}, {"github.login", "octo-cat"}, {"state.repo", "octo/agent-empire-state"}};
        for (String[] kv : ok) check(BridgePolicy.invalidValue(kv[0], kv[1], false) == null, "value ok: " + kv[0] + "=" + kv[1]);
        String[][] bad = {{"mode", "admin"}, {"mode", ""}, {"server.host", "https://city.example.com/"}, {"server.host", "http://city.example.com"},
            {"server.host", "https://u:p@city.example.com"}, {"server.host", "http://10.0.2.2:4713"}, {"server.token", "short"}, {"server.token", "has space in the token!!"},
            {"server.deviceId", "a b"}, {"github.token", "gho_x y"}, {"github.token", repeat("x", 513)}, {"github.login", "-octo"}, {"github.login", "a/b"},
            {"state.repo", "../x"}, {"state.repo", "octo"}, {"openai.key", "sk-x"}, {"mode", repeat("x", 9000)}};
        for (String[] kv : bad) check(BridgePolicy.invalidValue(kv[0], kv[1], false) != null, "value refused: " + kv[0] + "=" + kv[1]);
        check(BridgePolicy.invalidValue("server.host", "http://10.0.2.2:4713", true) == null, "debug build accepts the emulator host");
        check(BridgePolicy.invalidValue("mode", null, false) != null, "null value refused");
    }

    /** window.AGENT_EMPIRE_APP fields: parity with iOS (deviceName, mode, signedOut; server session only when valid). */
    private static void config() {
        String token = repeat("t", 20);
        java.util.Map<String, String> server = BridgePolicy.configFields("Pixel 7", "server", "https://city.example.com", token, "dev_1", null, false);
        eq(server.toString(), "{deviceName=Pixel 7, mode=server, host=https://city.example.com, token=" + token + ", deviceId=dev_1}");
        java.util.Map<String, String> cloud = BridgePolicy.configFields("Pixel 7", "cloud", "https://city.example.com", token, "dev_1", "revoked", false);
        eq(cloud.toString(), "{deviceName=Pixel 7, mode=cloud, signedOut=revoked}");
        java.util.Map<String, String> signedOut = BridgePolicy.configFields("Pixel 7", "server", "https://city.example.com", null, null, "unauthorized", false);
        eq(signedOut.toString(), "{deviceName=Pixel 7, mode=server, signedOut=unauthorized}");
        eq(BridgePolicy.configFields(null, null, null, null, null, null, false).toString(), "{deviceName=Android}");
        eq(BridgePolicy.configFields("Pixel", "admin", null, null, null, "hacked", false).toString(), "{deviceName=Pixel}");
        check(!BridgePolicy.configFields("Pixel", "server", "http://evil.test", token, null, null, false).containsKey("token"), "no token for an invalid host");
        check(!BridgePolicy.configFields("Pixel", "server", "https://city.example.com", token, "a b", null, false).containsKey("deviceId"), "malformed device id dropped");
        eq(BridgePolicy.configFields(repeat("n", 80), null, null, null, null, null, false).get("deviceName"), repeat("n", 64));
        eq(BridgePolicy.configFields("Pixel", null, "https://city.example.com", token, null, null, false).get("token"), token); // APP-02 session (no mode)
    }

    /** Every staged game file is reachable at its own URL path and has a non-generic MIME type (except known binaries). */
    private static void bundle(Path dir) throws Exception {
        check(Files.isRegularFile(dir.resolve("index.html")), "bundle has index.html");
        List<Path> files;
        try (Stream<Path> walk = Files.walk(dir)) { files = walk.filter(Files::isRegularFile).collect(Collectors.toList()); }
        for (Path file : files) {
            String rel = dir.relativize(file).toString().replace(File.separatorChar, '/');
            if (rel.equals(".DS_Store") || rel.endsWith("/.DS_Store")) continue;
            String path = "/" + encode(rel);
            eq(AssetPolicy.assetPath(path), "game/" + rel);
            String mime = AssetPolicy.mimeType(rel);
            check(!mime.equals("application/octet-stream") || rel.endsWith(".hdr") || rel.endsWith(".bin") || rel.endsWith(".exr"), "MIME known for " + rel);
        }
    }

    private static String encode(String rel) {
        StringBuilder out = new StringBuilder();
        for (char c : rel.toCharArray()) out.append(c == ' ' ? "%20" : String.valueOf(c));
        return out.toString();
    }

    private static String repeat(String s, int n) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < n; i++) out.append(s);
        return out.toString();
    }

    private static void eq(String actual, String expected) { check(expected.equals(actual), "expected " + expected + " but got " + actual); }

    private static void check(boolean ok, String what) {
        checks++;
        if (!ok) throw new AssertionError(what);
    }
}
