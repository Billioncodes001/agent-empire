// Host-side checks for the iOS app's pure policies (no simulator needed):
//   mobile/ios/Checks/run.sh
// Compiles HostPolicy.swift and GameSchemeHandler.swift for macOS with this file and exits non-zero on failure.
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

print(failures == 0 ? "All checks passed" : "\(failures) check(s) failed")
exit(failures == 0 ? 0 : 1)
