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
        if (args.length > 0) bundle(Paths.get(args[0]));
        System.out.println("PolicyTest: " + checks + " checks passed (origin, asset paths/traversal, MIME, config injection, server address, bridge rules"
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
            "app.openExternal,app.signedOut,github.deviceFlow,secure.delete,secure.get,secure.set");
        for (String bad : new String[]{null, "secure.list", "eval", "app.exit", "github.token"}) check(!BridgePolicy.isMethod(bad), "method rejected: " + bad);
        check(BridgePolicy.isRequestId("42") && BridgePolicy.isRequestId("req-1:a.b") && !BridgePolicy.isRequestId("a'b") && !BridgePolicy.isRequestId("x);alert(1") && !BridgePolicy.isRequestId(""), "ids");
        check(BridgePolicy.isClientId("Ov23li3G3aR4rgZ0lCJ3") && !BridgePolicy.isClientId("a b") && !BridgePolicy.isClientId("x&scope=admin"), "client ids");
        eq(BridgePolicy.scopes(Arrays.asList("repo", "workflow", "read:user")), "repo workflow read:user");
        eq(BridgePolicy.scopes(Arrays.<String>asList()), "");
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
