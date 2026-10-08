// Host-side checks for the iOS app's pure policies (no simulator needed):
//   mobile/ios/Checks/run.sh
// Compiles HostPolicy.swift and GameSchemeHandler.swift for macOS with this file and exits non-zero on failure.
import CryptoKit
import Foundation

var failures = 0
func check(_ ok: Bool, _ name: String) {
    print("\(ok ? "PASS" : "FAIL")  \(name)")
    if !ok { failures += 1 }
}

// MARK: HostPolicy

func origin(_ s: String, loopback: Bool) -> String? {
    if case .success(let url) = HostPolicy.origin(from: s, allowLoopbackHTTP: loopback) { return HostPolicy.originString(url) }
    return nil
}
func rejection(_ s: String, loopback: Bool) -> HostPolicy.Rejection? {
    if case .failure(let r) = HostPolicy.origin(from: s, allowLoopbackHTTP: loopback) { return r }
    return nil
}

check(origin("https://City.Example.com/", loopback: false) == "https://city.example.com", "https origin normalised")
check(origin("city.example.com", loopback: false) == "https://city.example.com", "bare host means https")
check(origin("https://city.example.com:443", loopback: false) == "https://city.example.com", "default port dropped")
check(origin("https://city.example.com:8443", loopback: false) == "https://city.example.com:8443", "custom port kept")
check(rejection("http://city.example.com", loopback: true) == .notHTTPS, "plain http refused for a remote host, even in Debug")
check(rejection("http://127.0.0.1:4705", loopback: false) == .notHTTPS, "Release refuses http loopback")
check(origin("http://127.0.0.1:4705", loopback: true) == "http://127.0.0.1:4705", "Debug allows http://127.0.0.1")
check(origin("http://localhost:4705", loopback: true) == "http://localhost:4705", "Debug allows http://localhost")
check(rejection("http://localhost.evil.com", loopback: true) == .notHTTPS, "look-alike loopback refused")
check(rejection("https://city.example.com/office", loopback: false) == .hasPath, "path refused")
check(rejection("https://city.example.com/?token=x", loopback: false) == .hasPath, "query refused")
check(rejection("https://u:p@city.example.com", loopback: false) == .hasCredentials, "credentials refused")
check(rejection("ftp://city.example.com", loopback: false) == .malformed, "other schemes refused")
check(rejection("   ", loopback: false) == .empty, "empty refused")

// MARK: GameSchemeHandler path resolution

let root = FileManager.default.temporaryDirectory.appendingPathComponent("ae-checks-\(UUID().uuidString)/Game", isDirectory: true)
let outside = root.deletingLastPathComponent().appendingPathComponent("secret.txt")
try FileManager.default.createDirectory(at: root.appendingPathComponent("assets"), withIntermediateDirectories: true)
try Data("<html>".utf8).write(to: root.appendingPathComponent("index.html"))
try Data("js".utf8).write(to: root.appendingPathComponent("assets/main.js"))
try Data("secret".utf8).write(to: outside)
try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("assets/link.txt"), withDestinationURL: outside)
defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }

func resolves(_ s: String) -> String? {
    guard let url = URL(string: s), let file = GameSchemeHandler.file(for: url, root: root) else { return nil }
    return String(file.path.dropFirst(root.resolvingSymlinksInPath().path.count))
}

check(resolves("empire-app://game/") == "/index.html", "root serves index.html")
check(resolves("empire-app://game/index.html") == "/index.html", "index.html")
check(resolves("empire-app://game/assets/main.js?v=1") == "/assets/main.js", "asset with query")
check(resolves("empire-app://game/../secret.txt") == nil, "dot-dot refused")
check(resolves("empire-app://game/assets/%2e%2e/%2e%2e/secret.txt") == nil, "encoded dot-dot refused")
check(resolves("empire-app://game/assets%2f..%2f..%2fsecret.txt") == nil, "encoded slash traversal refused")
check(resolves("empire-app://game/assets/link.txt") == nil, "symlink out of the Game folder refused")
check(resolves("empire-app://game/assets") == nil, "directory refused")
check(resolves("empire-app://game/missing.js") == nil, "missing file")
check(resolves("empire-app://other/index.html") == nil, "other host refused")
check(resolves("https://game/index.html") == nil, "other scheme refused")
check(resolves("empire-app://game:8080/index.html") == nil, "port refused")
check(resolves("empire-app://game/.hidden") == nil, "dotfile refused")
check(GameSchemeHandler.mimeType(for: URL(fileURLWithPath: "/a/b.glb")) == "model/gltf-binary", "glb MIME")
check(GameSchemeHandler.mimeType(for: URL(fileURLWithPath: "/a/b.js")).hasPrefix("text/javascript"), "js MIME")
check(GameSchemeHandler.mimeType(for: URL(fileURLWithPath: "/a/b.wav")) == "audio/wav", "wav MIME")

// MARK: Bridge protocol (docs/team/CLOUD_MODE_PLAN.md)

func parsed(_ body: Any) -> BridgeProtocol.Request? { if case .success(let r) = BridgeProtocol.parse(body) { return r }; return nil }
func valid(_ key: BridgeProtocol.Key, _ value: Any?, loopback: Bool = false) -> Bool {
    if case .success = BridgeProtocol.validate(key, value: value, allowLoopbackHTTP: loopback) { return true }
    return false
}

check(parsed(["id": "k1-2-abc", "method": "secure.get", "params": ["key": "mode"]])?.method == .secureGet, "bridge request parsed")
check(parsed(["id": "k1", "method": "eval", "params": [:]]) == nil, "unknown method refused")
check(parsed(["id": "bad id\"", "method": "secure.get"]) == nil, "malformed id refused")
check(parsed("not an object") == nil, "non-object refused")
check(BridgeProtocol.Key.allCases.map(\.rawValue) == ["mode", "server.host", "server.token", "server.deviceId", "github.token", "github.login", "state.repo"], "key allowlist matches the contract")
if case .failure(.badKey) = BridgeProtocol.key(["key": "provider.anthropic"]) { check(true, "provider keys are not storable") } else { check(false, "provider keys are not storable") }
check(valid(.mode, "cloud") && valid(.mode, "server") && !valid(.mode, "admin"), "mode values")
check(valid(.serverHost, "https://city.example.com") && !valid(.serverHost, "https://city.example.com/"), "server.host must be an exact origin")
check(!valid(.serverHost, "http://127.0.0.1:4707") && valid(.serverHost, "http://127.0.0.1:4707", loopback: true), "loopback http only when the build allows it")
check(!valid(.serverHost, "http://city.example.com", loopback: true), "remote http never")
check(valid(.serverToken, String(repeating: "a", count: 43)) && !valid(.serverToken, "short"), "device token shape")
check(!valid(.githubToken, "gho_x y") && valid(.githubToken, "gho_abc"), "GitHub token without whitespace")
check(valid(.stateRepo, "octo/agent-empire-state") && !valid(.stateRepo, "../x"), "state repo shape")
check(!valid(.mode, String(repeating: "x", count: 9000)), "oversized values refused")
if case .success(let a) = BridgeProtocol.deviceFlow(["clientId": "Ov23li3G3aR4rgZ0lCJ3", "scopes": ["repo", "workflow", "repo"]]) {
    check(a.scopes == ["repo", "workflow"], "device flow scopes de-duplicated")
} else { check(false, "device flow scopes de-duplicated") }
if case .failure(.badScopes) = BridgeProtocol.deviceFlow(["clientId": "Ov23li3G3aR4rgZ0lCJ3", "scopes": ["admin:org"]]) { check(true, "unknown scopes refused") } else { check(false, "unknown scopes refused") }
if case .failure(.badClientId) = BridgeProtocol.deviceFlow(["clientId": "", "scopes": ["repo"]]) { check(true, "empty client id refused") } else { check(false, "empty client id refused") }
if case .failure = BridgeProtocol.externalURL(["url": "http://example.com"]) { check(true, "openExternal: http refused") } else { check(false, "openExternal: http refused") }
if case .success = BridgeProtocol.externalURL(["url": "https://github.com/login/device"]) { check(true, "openExternal: https allowed") } else { check(false, "openExternal: https allowed") }
check(BridgeProtocol.resolveScript(id: "a1", result: ["token": "t\"</script>", "login": "o"]) == #"window.__empireNative&&window.__empireNative.resolve("a1",{"login":"o","token":"t\"<\/script>"});"#, "resolve script JSON-encodes its values")
check(BridgeProtocol.rejectScript(id: "a1", message: "line\u{2028}break").contains("\\u2028"), "U+2028 escaped in scripts")
let withSession = BridgeProtocol.configScript(deviceName: "iPhone", mode: "server", host: "https://city.example.com", token: String(repeating: "t", count: 20), deviceId: "dev_1", signedOut: nil, allowLoopbackHTTP: false)
check(withSession.contains(#""host":"https:\/\/city.example.com""#) && withSession.contains(#""platform":"ios""#) && withSession.contains(#""deviceId":"dev_1""#), "config carries a valid server session")
let cloudCfg = BridgeProtocol.configScript(deviceName: "iPhone", mode: "cloud", host: "https://city.example.com", token: String(repeating: "t", count: 20), deviceId: nil, signedOut: "revoked", allowLoopbackHTTP: false)
check(!cloudCfg.contains("token") && cloudCfg.contains(#""mode":"cloud""#) && cloudCfg.contains(#""signedOut":"revoked""#), "no server session injected outside server mode")
let firstRun = BridgeProtocol.configScript(deviceName: "iPhone", mode: nil, host: nil, token: nil, deviceId: nil, signedOut: nil)
check(firstRun.contains(#""platform":"ios""#) && !firstRun.contains("mode"), "first launch injects only the platform")

// Security review fixes (M1, L4, L5)
check(BridgeProtocol.sessionKeys.map(\.rawValue) == ["server.token", "server.deviceId", "github.token", "github.login"], "sign-out clears every credential (same set as Android SESSION_KEYS)")
check(!BridgeProtocol.sessionKeys.contains(.mode) && !BridgeProtocol.sessionKeys.contains(.serverHost) && !BridgeProtocol.sessionKeys.contains(.stateRepo), "sign-out keeps mode, server address and state repository")
check(BridgeProtocol.isGitHubVerificationURL(URL(string: "https://github.com/login/device")!), "device flow: github.com verification page accepted")
check(BridgeProtocol.isGitHubVerificationURL(URL(string: "https://www.github.com/login/device")!), "device flow: a github.com subdomain accepted")
check(!BridgeProtocol.isGitHubVerificationURL(URL(string: "https://evilgithub.com/login/device")!), "device flow: look-alike host evilgithub.com refused")
check(!BridgeProtocol.isGitHubVerificationURL(URL(string: "https://github.com.evil.io/login/device")!), "device flow: github.com prefix on another host refused")
check(!BridgeProtocol.isGitHubVerificationURL(URL(string: "http://github.com/login/device")!), "device flow: http verification page refused")
do {
    var gate = BridgeProtocol.GestureGate()
    let t0 = Date()
    check(!gate.consume(at: t0), "openExternal: no touch, no direct open")
    gate.touched(at: t0)
    check(gate.consume(at: t0.addingTimeInterval(1)), "openExternal: a touch allows one direct open")
    check(!gate.consume(at: t0.addingTimeInterval(1.5)), "openExternal: the same touch can't open a second page")
    gate.touched(at: t0)
    check(!gate.consume(at: t0.addingTimeInterval(6)), "openExternal: a touch older than 5 s doesn't count")
}

// MARK: In-app updates (REL-04)

let repoURL = "https://github.com/\(UpdatePolicy.releaseRepo)"
check(UpdatePolicy.releaseKeyIsDevelopment && UpdatePolicy.releasePublicKey.count == 44, "updates: the development release key is pinned (same string as src/shared/release-key.ts)")
check(UpdatePolicy.releaseAsset("\(repoURL)/releases/download/v1.0.0-beta.2/agent-empire-game-1.0.0-beta.2.zip")?.tag == "v1.0.0-beta.2", "updates: release asset parsed")
check(UpdatePolicy.releaseAsset("\(repoURL)/releases/latest/download/channel-stable.json").map { $0.tag == nil } == true, "updates: latest asset")
for bad in ["https://evil.test/a.zip", "\(repoURL)/releases/download/../a.zip", "\(repoURL)/releases/download/v1/%2e%2e", "\(repoURL)/releases/download/v1/a.zip?x=1",
            "http://github.com/\(UpdatePolicy.releaseRepo)/releases/download/v1/a.zip", "https://github.com:444/\(UpdatePolicy.releaseRepo)/releases/download/v1/a.zip",
            "https://github.com/evil/agent-empire/releases/download/v1/a.zip", "\(repoURL)/archive/v1.zip"] {
    check(UpdatePolicy.releaseAsset(bad) == nil && !UpdatePolicy.isTaggedAsset(bad), "updates: release asset refused \(bad)")
}
check(UpdatePolicy.isFetchURL(UpdatePolicy.releasesAPI) && !UpdatePolicy.isFetchURL("https://api.github.com/user"), "updates: fetchable URLs")
check(UpdatePolicy.isAssetRedirect(URL(string: "https://release-assets.githubusercontent.com/x?sig=1")!) && !UpdatePolicy.isAssetRedirect(URL(string: "https://evil.test/x")!)
      && !UpdatePolicy.isAssetRedirect(URL(string: "http://objects.githubusercontent.com/x")!), "updates: redirect hosts")
check(UpdatePolicy.isAppleURL("https://testflight.apple.com/join/AbC") && UpdatePolicy.isAppleURL("https://apps.apple.com/app/id1") && !UpdatePolicy.isAppleURL("https://apple.com.evil.test/x"), "updates: store links")
let order = ["0.1.0", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.10", "1.0.0-rc.1", "1.0.0", "1.0.1", "2.0.0"]
check(zip(order, order.dropFirst()).allSatisfy { UpdatePolicy.compare($0, $1) < 0 }, "updates: SemVer precedence")
check(["1.0", "v1.0.0", "01.0.0", "1.0.0-", "1.0.0+b", ""].allSatisfy { !UpdatePolicy.isSemver($0) }, "updates: malformed versions refused")
check(UpdatePolicy.shellVersion(marketing: "1.0.0", build: "10000301") == "1.0.0-beta.1", "updates: build number 10000301 is 1.0.0-beta.1")
check(UpdatePolicy.shellVersion(marketing: "1.0.0", build: "10000999") == "1.0.0" && UpdatePolicy.shellVersion(marketing: "1.0.0", build: "1") == "1.0.0"
      && UpdatePolicy.shellVersion(marketing: "1.0.0", build: "20000301") == "1.0.0", "updates: shell version falls back to the marketing version")
check(["index.html", "assets/main.js", "assets/"].allSatisfy(UpdatePolicy.safeEntryName), "updates: safe zip names")
check(["../x", "a/../../x", "/etc/passwd", "C:/x", "a\\b", "a\u{0}b", "a//b", "./x"].allSatisfy { !UpdatePolicy.safeEntryName($0) }, "updates: zip-slip names refused")
check(UpdatePolicy.fixtureURL(UpdatePolicy.releasesAPI, origin: "http://127.0.0.1:4719")?.absoluteString == "http://127.0.0.1:4719/api/repos/\(UpdatePolicy.releaseRepo)/releases?per_page=20", "updates: fixture mapping")

check(parsed(["id": "u1", "method": "update.installGame", "params": [:]])?.method == .updateInstallGame, "updates: bridge method parsed")
if case .failure = BridgeProtocol.installGame(["url": "https://evil.test/a.zip", "sha256": String(repeating: "a", count: 64), "version": "1.0.0"]) { check(true, "updates: installGame refuses other hosts") } else { check(false, "updates: installGame refuses other hosts") }
if case .failure = BridgeProtocol.installGame(["url": "\(repoURL)/releases/download/v1.0.0/a.zip", "sha256": "ABC", "version": "1.0.0"]) { check(true, "updates: installGame refuses a bad sha256") } else { check(false, "updates: installGame refuses a bad sha256") }
if case .success = BridgeProtocol.installGame(["url": "\(repoURL)/releases/download/v1.0.0/a.zip", "sha256": String(repeating: "a", count: 64), "version": "1.0.0"]) { check(true, "updates: installGame accepts a release") } else { check(false, "updates: installGame accepts a release") }
if case .success(let f) = BridgeProtocol.updateFetch(["url": UpdatePolicy.releasesAPI, "etag": "W/\"x\""]) { check(f.etag == "W/\"x\"", "updates: fetch keeps a valid ETag") } else { check(false, "updates: fetch keeps a valid ETag") }
if case .success(let u) = BridgeProtocol.storeURL(["version": "1.0.1", "testflight": "https://testflight.apple.com/join/AbC"]) { check(u.host == "testflight.apple.com", "updates: openNative opens TestFlight") } else { check(false, "updates: openNative opens TestFlight") }
if case .failure = BridgeProtocol.storeURL(["version": "1.0.1", "testflight": "https://evil.test/x"]) { check(true, "updates: openNative refuses other links") } else { check(false, "updates: openNative refuses other links") }

/// A stored-only zip writer for the checks (with unix modes for symlink cases).
func makeZip(_ files: [(String, String, UInt32)]) -> Data {
    var local = Data(), central = Data()
    func le16(_ v: Int) -> Data { Data([UInt8(v & 0xff), UInt8(v >> 8 & 0xff)]) }
    func le32(_ v: Int) -> Data { le16(v & 0xffff) + le16(v >> 16 & 0xffff) }
    func join(_ parts: [Data]) -> Data { parts.reduce(Data(), +) }
    for (name, text, mode) in files {
        let n = Data(name.utf8), body = Data(text.utf8), offset = local.count
        let header: [Data] = [le32(0x04034b50), le16(20), le16(0), le16(0), le32(0), le32(0), le32(body.count), le32(body.count), le16(n.count), le16(0), n, body]
        local += join(header)
        let entry: [Data] = [le32(0x02014b50), le16(3 << 8 | 20), le16(20), le16(0), le16(0), le32(0), le32(0), le32(body.count), le32(body.count),
                             le16(n.count), le16(0), le16(0), le16(0), le16(0), le32(Int(mode) << 16), le32(offset), n]
        central += join(entry)
    }
    let end: [Data] = [le32(0x06054b50), le16(0), le16(0), le16(files.count), le16(files.count), le32(central.count), le32(local.count), le16(0)]
    return local + central + join(end)
}
func gameZip(_ v: String) -> Data { makeZip([("index.html", "<title>game \(v)</title>", 0o100644), ("game-version.json", "{\"version\":\"\(v)\"}", 0o100644), ("assets/", "", 0o040755), ("assets/main.js", "1", 0o100644)]) }

let updRoot = FileManager.default.temporaryDirectory.appendingPathComponent("ae-updates-\(UUID().uuidString)", isDirectory: true)
defer { try? FileManager.default.removeItem(at: updRoot) }
try FileManager.default.createDirectory(at: updRoot, withIntermediateDirectories: true)
for (name, z) in [("dot-dot", makeZip([("../evil.txt", "x", 0o100644)])), ("absolute", makeZip([("/tmp/evil.txt", "x", 0o100644)])),
                  ("symlink", makeZip([("index.html", "/etc/passwd", 0o120777)])), ("backslash", makeZip([("..\\evil.txt", "x", 0o100644)])),
                  ("duplicate", makeZip([("index.html", "a", 0o100644), ("INDEX.html", "b", 0o100644)])), ("not a zip", Data("nope".utf8))] {
    let dest = updRoot.appendingPathComponent("hostile-\(name)")
    let threw = (try? ZipExtractor.extract(z, to: dest)) == nil
    check(threw && !FileManager.default.fileExists(atPath: updRoot.appendingPathComponent("evil.txt").path), "updates: zip-slip refused (\(name))")
}
do {
    let dest = updRoot.appendingPathComponent("good")
    try ZipExtractor.extract(gameZip("1.0.0"), to: dest)
    check(GameUpdater.version(of: dest) == "1.0.0" && FileManager.default.fileExists(atPath: dest.appendingPathComponent("assets/main.js").path), "updates: a game zip unpacks")
} catch { check(false, "updates: a game zip unpacks (\(error))") }

// Bundle store state machine with a fake clock.
let builtinDir = updRoot.appendingPathComponent("Game", isDirectory: true)
try FileManager.default.createDirectory(at: builtinDir, withIntermediateDirectories: true)
try Data("<title>built-in</title>".utf8).write(to: builtinDir.appendingPathComponent("index.html"))
try Data("{\"version\":\"1.0.0-beta.1\"}".utf8).write(to: builtinDir.appendingPathComponent("game-version.json"))
var clock: TimeInterval = 1000
let bundles = updRoot.appendingPathComponent("game-bundles", isDirectory: true)
func store() -> GameUpdater { GameUpdater(root: bundles, builtinRoot: builtinDir, now: { clock }) }
let s1 = store()
s1.launch()
check(s1.servingRoot() == builtinDir && s1.installedGame == "1.0.0-beta.1", "updates: the built-in game serves first")
check((try? s1.place(zip: gameZip("1.0.0-beta.1"), version: "1.0.0-beta.1")) == nil, "updates: no reinstall of the built-in version (forward only)")
check((try? s1.place(zip: gameZip("0.9.0"), version: "0.9.0")) == nil, "updates: no downgrade")
check((try? s1.place(zip: gameZip("1.0.0-beta.3"), version: "1.0.0-beta.4")) == nil, "updates: files for another version refused")
check((try? s1.place(zip: gameZip("1.0.0-beta.2"), version: "1.0.0-beta.2")) == "1.0.0-beta.2" && s1.pendingGame == "1.0.0-beta.2", "updates: installed and pending")
check(s1.servingRoot() == builtinDir, "updates: not switched before activate or the next start")
check(s1.activate() && s1.servingRoot()?.lastPathComponent == "1.0.0-beta.2", "updates: activate serves the new bundle")
clock += 19
check(!s1.checkTrial(), "updates: still within 20 s")
s1.bootOk()
check(s1.state.knownGood == "1.0.0-beta.2" && s1.state.trialVersion == nil, "updates: bootOk makes it known-good")
_ = try? s1.place(zip: gameZip("1.0.0-beta.3"), version: "1.0.0-beta.3")
check(s1.activate(), "updates: second update on trial")
clock += 21
check(s1.checkTrial() && s1.servingRoot()?.lastPathComponent == "1.0.0-beta.2" && s1.takeRolledBack() == "1.0.0-beta.3", "updates: no boot report in 20 s rolls back to known-good")
check((try? s1.place(zip: gameZip("1.0.0-beta.3"), version: "1.0.0-beta.3")) == nil, "updates: a version that failed to boot is never installed again")
_ = try? s1.place(zip: gameZip("1.0.0-beta.5"), version: "1.0.0-beta.5")
let s2 = store()
s2.launch() // next start: the pending bundle becomes the trial
check(s2.servingRoot()?.lastPathComponent == "1.0.0-beta.5" && s2.state.trialVersion == "1.0.0-beta.5", "updates: pending switches at the next start")
let s3 = store()
s3.launch() // it never reported booting
check(s3.servingRoot()?.lastPathComponent == "1.0.0-beta.2" && s3.takeRolledBack() == "1.0.0-beta.5", "updates: an unfinished trial rolls back at launch")
check(GameSchemeHandler.file(for: URL(string: "empire-app://game/index.html")!, root: s3.servingRoot()!) != nil
      && GameSchemeHandler.file(for: URL(string: "empire-app://game/../state.json")!, root: s3.servingRoot()!) == nil, "updates: the scheme handler serves the active bundle with the same rules")

// MARK: Security review: the shell's own Ed25519 check and request binding

do {
    // A key pair whose public half is not pinned: signatures by it must fail against the pinned key.
    let other = Curve25519.Signing.PrivateKey()
    let msg = Data("{\"version\":\"1.0.1\"}".utf8)
    let sig = try other.signature(for: msg).base64EncodedString()
    check(UpdatePolicy.verifyEd25519(msg, signatureBase64: sig, publicKeyBase64: other.publicKey.rawRepresentation.base64EncodedString()), "security: Ed25519 verifies with CryptoKit")
    check(!UpdatePolicy.verifyEd25519(msg, signatureBase64: sig), "security: another key's signature fails against the pinned key")
    check(!UpdatePolicy.verifyEd25519(Data("tampered".utf8), signatureBase64: sig, publicKeyBase64: other.publicKey.rawRepresentation.base64EncodedString()), "security: tampering fails")
    check(!UpdatePolicy.verifyEd25519(msg, signatureBase64: "garbage"), "security: garbage fails")
    let url = "\(repoURL)/releases/download/v1.0.1/agent-empire-game-1.0.1.zip", sha = String(repeating: "a", count: 64)
    let doc: [String: Any] = ["schema": 1, "version": "1.0.1", "tag": "v1.0.1", "game": ["url": url, "sha256": sha, "minShell": "1.0.0"]]
    check(UpdatePolicy.releaseMismatch(doc, version: "1.0.1", url: url, sha256: sha, shellVersion: "1.0.0") == nil, "security: a request matching the signed release")
    check(UpdatePolicy.releaseMismatch(doc, version: "1.0.1", url: url, sha256: String(repeating: "b", count: 64), shellVersion: "1.0.0") != nil, "security: another sha256 refused")
    check(UpdatePolicy.releaseMismatch(doc, version: "1.0.2", url: url, sha256: sha, shellVersion: "1.0.0") != nil, "security: another version refused")
    check(UpdatePolicy.releaseMismatch(doc, version: "1.0.1", url: url, sha256: sha, shellVersion: "0.9.0") != nil, "security: minShell above the app refused")
    check(UpdatePolicy.releaseChannelURL("1.0.1") == "\(repoURL)/releases/download/v1.0.1/channel-beta.json", "security: signed release URL")
} catch { check(false, "security checks threw \(error)") }

// A reinstalled app starts signed out: only the first launch of an install claims the wipe.
do {
    let suite = "com.agentempire.checks.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    check(InstallMarker.isFreshInstall(defaults), "reinstall: the first launch of an install wipes the stored sign-in")
    check(InstallMarker.isFreshInstall(defaults), "reinstall: a wipe that did not complete is retried on the next launch")
    InstallMarker.markInstalled(defaults)
    check(!InstallMarker.isFreshInstall(defaults), "reinstall: after a completed wipe, later launches keep the sign-in")
    defaults.removePersistentDomain(forName: suite)
    check(InstallMarker.isFreshInstall(UserDefaults(suiteName: suite)!), "reinstall: deleting the app's defaults (an uninstall) wipes again")
    UserDefaults(suiteName: suite)!.removePersistentDomain(forName: suite)
}

print(failures == 0 ? "All checks passed" : "\(failures) check(s) failed")
exit(failures == 0 ? 0 : 1)
