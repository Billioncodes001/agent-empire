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
        // REL-07: the owner's key is pinned; only the debug variant (DevTrust from src/debug/java) also trusts the dev key.
        String variant = System.getProperty("ae.variant", "debug");
        check(UpdatePolicy.RELEASE_PUBLIC_KEY.equals("rIRaOVUyoolaIritW/W8zMW7kGymgcjvg7uXhHtTqPk="), "owner release key pinned (same string as src/shared/release-key.ts)");
        if (variant.equals("release")) check(!UpdatePolicy.DEV_KEY_TRUSTED && UpdatePolicy.TRUSTED_KEYS.equals(java.util.Collections.singletonList(UpdatePolicy.RELEASE_PUBLIC_KEY)), "release variant: trusts only the release key");
        else check(UpdatePolicy.DEV_KEY_TRUSTED && "q7m8HRpNA8EClSZsC3KSzzInRy3LxrjPIXNU41+WLYU=".equals(UpdatePolicy.DEV_RELEASE_PUBLIC_KEY)
            && UpdatePolicy.TRUSTED_KEYS.equals(java.util.Arrays.asList(UpdatePolicy.RELEASE_PUBLIC_KEY, UpdatePolicy.DEV_RELEASE_PUBLIC_KEY)), "debug variant: trusts the release key and the dev key");
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
        security();
        ed25519();
    }

    private static byte[] hex(String s) {
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(s.substring(2 * i, 2 * i + 2), 16);
        return out;
    }

    /** The shell's own verifier (Ed25519.java): RFC 8032 vectors, agreement with the JDK, and malformed input. */
    private static void ed25519() throws Exception {
        byte[] pk1 = hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
        byte[] sig1 = hex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
        check(Ed25519.verify(pk1, new byte[0], sig1), "Ed25519: RFC 8032 test 1 verifies");
        byte[] pk2 = hex("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c");
        byte[] sig2 = hex("92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00");
        check(Ed25519.verify(pk2, new byte[] {0x72}, sig2), "Ed25519: RFC 8032 test 2 verifies");
        check(!Ed25519.verify(pk2, new byte[] {0x73}, sig2), "Ed25519: another message fails");
        check(!Ed25519.verify(pk1, new byte[] {0x72}, sig2), "Ed25519: another key fails");
        // s + L encodes the same scalar mod L; RFC 8032 requires rejecting s >= L (signature malleability).
        java.math.BigInteger l = java.math.BigInteger.ONE.shiftLeft(252).add(new java.math.BigInteger("27742317777372353535851937790883648493"));
        byte[] sBytes = new byte[32];
        System.arraycopy(sig2, 32, sBytes, 0, 32);
        byte[] be = new byte[32];
        for (int i = 0; i < 32; i++) be[i] = sBytes[31 - i];
        byte[] big = new java.math.BigInteger(1, be).add(l).toByteArray();
        byte[] malleable = sig2.clone();
        for (int i = 0; i < 32; i++) malleable[32 + i] = i < big.length ? big[big.length - 1 - i] : 0;
        check(!Ed25519.verify(pk2, new byte[] {0x72}, malleable), "Ed25519: s >= L is refused");
        check(!Ed25519.verify(new byte[31], new byte[0], sig1) && !Ed25519.verify(pk1, new byte[0], new byte[63]), "Ed25519: wrong lengths are refused");
        byte[] notOnCurve = pk1.clone();
        notOnCurve[0] = 2; // y = 2 has no x on the curve
        for (int i = 1; i < 32; i++) notOnCurve[i] = 0;
        check(!Ed25519.verify(notOnCurve, new byte[0], sig1), "Ed25519: a key that is not a curve point is refused");
        // Agreement with the JDK's signer over random keys and messages.
        java.security.KeyPairGenerator gen = java.security.KeyPairGenerator.getInstance("Ed25519");
        java.util.Random random = new java.util.Random(7);
        int agreed = 0;
        for (int i = 0; i < 40; i++) {
            java.security.KeyPair pair = gen.generateKeyPair();
            byte[] spki = pair.getPublic().getEncoded();
            byte[] raw = java.util.Arrays.copyOfRange(spki, spki.length - 32, spki.length);
            byte[] message = new byte[random.nextInt(300)];
            random.nextBytes(message);
            java.security.Signature signer = java.security.Signature.getInstance("Ed25519");
            signer.initSign(pair.getPrivate());
            signer.update(message);
            byte[] signature = signer.sign();
            byte[] flipped = signature.clone();
            flipped[random.nextInt(64)] ^= (byte) (1 << random.nextInt(8));
            if (Ed25519.verify(raw, message, signature) && !Ed25519.verify(raw, message, flipped)) agreed++;
        }
        check(agreed == 40, "Ed25519: agrees with the JDK on 40 random signatures and their bit-flipped copies (" + agreed + "/40)");
    }

    /** Security review: the shell's own Ed25519 check, request binding to the signed release, install status (#4). */
    private static void security() throws Exception {
        // Signed with the public development seed (tools/release/sign.mjs DEV_KEY_SEED_TEXT), as the release tooling does.
        byte[] seed = java.security.MessageDigest.getInstance("SHA-256").digest("agent-empire/dev-release-key/v1: public test key, never trusted by a release build".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        byte[] pkcs8 = new byte[48];
        byte[] prefix = {0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20};
        System.arraycopy(prefix, 0, pkcs8, 0, 16);
        System.arraycopy(seed, 0, pkcs8, 16, 32);
        java.security.PrivateKey key = java.security.KeyFactory.getInstance("Ed25519").generatePrivate(new java.security.spec.PKCS8EncodedKeySpec(pkcs8));
        byte[] msg = "{\"version\":\"1.0.1\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        java.security.Signature signer = java.security.Signature.getInstance("Ed25519");
        signer.initSign(key);
        signer.update(msg);
        String sig = java.util.Base64.getEncoder().encodeToString(signer.sign());
        String devKey = "q7m8HRpNA8EClSZsC3KSzzInRy3LxrjPIXNU41+WLYU=";
        check(Boolean.TRUE.equals(UpdatePolicy.verifyEd25519(msg, sig + "\n", devKey)), "Ed25519: the dev-signed release verifies against the dev key");
        check(!UpdatePolicy.verifyEd25519(msg, sig, UpdatePolicy.RELEASE_PUBLIC_KEY), "Ed25519: a dev-signed release does not verify against the owner's release key");
        check(UpdatePolicy.verifyTrusted(msg, sig, UpdatePolicy.TRUSTED_KEYS) == UpdatePolicy.DEV_KEY_TRUSTED, "Ed25519: the trusted set accepts a dev signature only in the debug variant (" + variant + ")");
        check(!UpdatePolicy.verifyTrusted(msg, sig, java.util.Collections.singletonList(UpdatePolicy.RELEASE_PUBLIC_KEY)), "Ed25519: the release set refuses a dev signature");
        byte[] tampered = msg.clone();
        tampered[3] ^= 1;
        check(Boolean.FALSE.equals(UpdatePolicy.verifyEd25519(tampered, sig, devKey)) && !UpdatePolicy.verifyTrusted(tampered, sig, UpdatePolicy.TRUSTED_KEYS), "Ed25519: tampering fails");
        check(Boolean.FALSE.equals(UpdatePolicy.verifyEd25519(msg, "garbage", devKey)) && !UpdatePolicy.verifyTrusted(msg, "garbage", UpdatePolicy.TRUSTED_KEYS), "Ed25519: garbage fails");
        // In an Android 13+ app process the first "Ed25519" KeyFactory and Signature come from Android Keystore, which only
        // handles keys kept in the Keystore: importing the pinned raw key throws (found on the Android 15 emulator,
        // docs/team/reports/update-device-rerun.md). That must never turn a genuine release into "signature does not match".
        // Android 15 has no software Ed25519 provider (Conscrypt offers none), and unlike the JDK its KeyFactory does not
        // fail over to the next provider, so the JDK's own Ed25519 provider is taken out for this check.
        java.security.Provider[] installed = java.security.Security.getProviders();
        java.util.List<java.security.Provider> software = new java.util.ArrayList<>();
        for (java.security.Provider p : installed) if (p.getService("KeyFactory", "Ed25519") != null) software.add(p);
        for (java.security.Provider p : software) java.security.Security.removeProvider(p.getName());
        java.security.Security.insertProviderAt(new FakeKeystoreProvider(), 1);
        try {
            check(UpdatePolicy.verifyEd25519(msg, sig, devKey), "Ed25519: with only Android Keystore's Ed25519 the shell still verifies a genuine release itself");
            check(!UpdatePolicy.verifyEd25519(tampered, sig, devKey), "Ed25519: with only Android Keystore's Ed25519 tampering is still refused");
        } finally {
            java.security.Security.removeProvider("AndroidKeyStore");
            for (java.security.Provider p : software) java.security.Security.insertProviderAt(p, java.util.Arrays.asList(installed).indexOf(p) + 1);
        }
        check(Boolean.TRUE.equals(UpdatePolicy.verifyEd25519(msg, sig, devKey)), "Ed25519: providers restored");
        String url = "https://github.com/" + UpdatePolicy.RELEASE_REPO + "/releases/download/v1.0.1/agent-empire-game-1.0.1.zip", sha = repeat("a", 64);
        check(UpdatePolicy.releaseMismatch("1.0.1", "v1.0.1", url, sha, "1.0.0", "1.0.1", url, sha, "1.0.0") == null, "request matches the signed release");
        check(UpdatePolicy.releaseMismatch("1.0.1", "v1.0.1", url, sha, "1.0.0", "1.0.1", url, repeat("b", 64), "1.0.0") != null, "another sha256 is refused");
        check(UpdatePolicy.releaseMismatch("1.0.2", null, url, sha, null, "1.0.1", url, sha, "1.0.0") != null, "another version is refused");
        check(UpdatePolicy.releaseMismatch("1.0.1", "v1.0.1", url, sha, "1.1.0", "1.0.1", url, sha, "1.0.0") != null, "minShell above the app is refused");
        check(UpdatePolicy.releaseChannelUrl("1.0.1").equals("https://github.com/" + UpdatePolicy.RELEASE_REPO + "/releases/download/v1.0.1/channel-beta.json"), "signed release URL");
        String nonce = repeat("n", 48);
        check(UpdatePolicy.installStatusAccepted(nonce, nonce) && !UpdatePolicy.installStatusAccepted(nonce, null) && !UpdatePolicy.installStatusAccepted(nonce, repeat("m", 48))
            && !UpdatePolicy.installStatusAccepted(null, nonce) && !UpdatePolicy.installStatusAccepted(null, null), "install status needs this session's nonce");
        String confirm = "android.content.pm.action.CONFIRM_INSTALL";
        for (String oem : new String[]{"com.google.android.packageinstaller", "com.android.packageinstaller", "com.miui.packageinstaller", "com.samsung.android.packageinstaller"}) {
            check(UpdatePolicy.isInstallerConfirmation(confirm, oem, UpdatePolicy.FLAG_SYSTEM), "built-in installer confirms: " + oem);
            check(UpdatePolicy.isInstallerConfirmation(confirm, oem, UpdatePolicy.FLAG_UPDATED_SYSTEM_APP), "updated built-in installer confirms: " + oem);
            check(!UpdatePolicy.isInstallerConfirmation(confirm, oem, 0), "a non-system app is refused even with an installer name: " + oem);
        }
        check(UpdatePolicy.isInstallerConfirmation("android.content.pm.action.CONFIRM_PERMISSIONS", "com.android.packageinstaller", UpdatePolicy.FLAG_SYSTEM), "permission review confirmation");
        check(!UpdatePolicy.isInstallerConfirmation("android.intent.action.VIEW", "com.android.settings", UpdatePolicy.FLAG_SYSTEM), "another system activity (not an installer confirmation) is refused");
        check(!UpdatePolicy.isInstallerConfirmation(null, "com.android.packageinstaller", UpdatePolicy.FLAG_SYSTEM) && !UpdatePolicy.isInstallerConfirmation(confirm, null, UpdatePolicy.FLAG_SYSTEM), "missing action or target refused");
        long now = 1_000_000_000L;
        check(UpdatePolicy.installPendingState("1.0.2", now - 60_000, "1.0.1", now).equals("show"), "killed mid-install: tell the player to tap Update again");
        check(UpdatePolicy.installPendingState("1.0.2", now - 60_000, "1.0.2", now).equals("done"), "installed: forget the marker");
        check(UpdatePolicy.installPendingState("1.0.2", now - UpdatePolicy.INSTALL_PENDING_MAX_MS - 1, "1.0.1", now).equals("stale"), "older than a day: forget");
        check(UpdatePolicy.installPendingState("latest", now, "1.0.1", now).equals("stale") && UpdatePolicy.installPendingState("1.0.2", now + 5, "1.0.1", now).equals("stale"), "malformed marker: forget");
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

    /** Stands in for Android Keystore's Ed25519 KeyFactory and Signature: they refuse any key not kept in the Keystore. */
    public static final class FakeKeystoreProvider extends java.security.Provider {
        public FakeKeystoreProvider() {
            super("AndroidKeyStore", 1.0, "test stand-in for Android Keystore");
            put("KeyFactory.Ed25519", FakeKeystoreKeyFactory.class.getName());
            put("Signature.Ed25519", FakeKeystoreSignature.class.getName());
        }
    }

    public static final class FakeKeystoreKeyFactory extends java.security.KeyFactorySpi {
        private static java.security.spec.InvalidKeySpecException refuse() { return new java.security.spec.InvalidKeySpecException("To generate a key pair in Android Keystore, use KeyPairGenerator"); }
        @Override protected java.security.PublicKey engineGeneratePublic(java.security.spec.KeySpec spec) throws java.security.spec.InvalidKeySpecException { throw refuse(); }
        @Override protected java.security.PrivateKey engineGeneratePrivate(java.security.spec.KeySpec spec) throws java.security.spec.InvalidKeySpecException { throw refuse(); }
        @Override protected <T extends java.security.spec.KeySpec> T engineGetKeySpec(java.security.Key key, Class<T> type) throws java.security.spec.InvalidKeySpecException { throw refuse(); }
        @Override protected java.security.Key engineTranslateKey(java.security.Key key) throws java.security.InvalidKeyException { throw new java.security.InvalidKeyException("Keystore keys only"); }
    }

    public static final class FakeKeystoreSignature extends java.security.SignatureSpi {
        @Override protected void engineInitVerify(java.security.PublicKey key) throws java.security.InvalidKeyException { throw new java.security.InvalidKeyException("Keystore keys only"); }
        @Override protected void engineInitSign(java.security.PrivateKey key) throws java.security.InvalidKeyException { throw new java.security.InvalidKeyException("Keystore keys only"); }
        @Override protected void engineUpdate(byte b) { }
        @Override protected void engineUpdate(byte[] b, int off, int len) { }
        @Override protected byte[] engineSign() { return new byte[0]; }
        @Override protected boolean engineVerify(byte[] sig) { return false; }
        @Override @Deprecated protected void engineSetParameter(String param, Object value) { }
        @Override @Deprecated protected Object engineGetParameter(String param) { return null; }
    }

    private static void check(boolean ok, String what) {
        checks++;
        if (!ok) throw new AssertionError(what);
    }
}
