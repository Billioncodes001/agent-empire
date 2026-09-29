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

print(failures == 0 ? "All checks passed" : "\(failures) check(s) failed")
exit(failures == 0 ? 0 : 1)
