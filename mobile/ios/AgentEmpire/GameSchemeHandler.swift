import Foundation
import WebKit

/// Serves the bundled game (a copy of dist/public in the app's "Game" folder) at empire-app://game/.
/// Read-only, GET/HEAD only, and a request can never resolve outside the Game folder.
final class GameSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "empire-app"
    static let host = "game"
    static let startURL = URL(string: "empire-app://game/index.html")!

    /// The bundled Game folder, or nil when this build has no game files.
    static var bundledRoot: URL? {
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("Game", isDirectory: true) else { return nil }
        return FileManager.default.fileExists(atPath: url.appendingPathComponent("index.html").path) ? url : nil
    }

    /// The folder to serve, asked per request: the active installed game bundle (in-app updates, GameUpdater), else
    /// the bundled Game folder, which is always the final fallback.
    private let rootProvider: () -> URL
    private var running = Set<ObjectIdentifier>()

    init(root: URL) {
        let fixed = root.standardizedFileURL.resolvingSymlinksInPath()
        rootProvider = { fixed }
    }

    init(rootProvider: @escaping () -> URL) {
        self.rootProvider = rootProvider
    }

    static let mimeTypes: [String: String] = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8", "json": "application/json", "webmanifest": "application/manifest+json",
        "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp",
        "gif": "image/gif", "ico": "image/x-icon", "avif": "image/avif", "ktx2": "image/ktx2",
        "glb": "model/gltf-binary", "gltf": "model/gltf+json", "bin": "application/octet-stream", "hdr": "application/octet-stream",
        "wasm": "application/wasm", "wav": "audio/wav", "mp3": "audio/mpeg", "ogg": "audio/ogg", "m4a": "audio/mp4",
        "mp4": "video/mp4", "webm": "video/webm", "woff": "font/woff", "woff2": "font/woff2", "ttf": "font/ttf",
        "txt": "text/plain; charset=utf-8", "md": "text/markdown; charset=utf-8",
    ]

    static func mimeType(for file: URL) -> String {
        mimeTypes[file.pathExtension.lowercased()] ?? "application/octet-stream"
    }

    /// Maps a request URL to a file inside `root`, or nil. Rejects other schemes/hosts, credentials, ports,
    /// dot segments (also when percent-encoded), backslashes, NULs, directories and symlinks leading outside.
    static func file(for url: URL, root: URL) -> URL? {
        guard url.scheme?.lowercased() == scheme, url.host?.lowercased() == host,
              url.user == nil, url.password == nil, url.port == nil else { return nil }
        var path = url.path // percent-decoded
        if path.isEmpty { path = "/" }
        if path.hasSuffix("/") { path += "index.html" }
        let parts = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        // Dot segments and dotfiles, plus separators and NULs that only appear once decoded.
        if parts.isEmpty || parts.contains(where: { $0.hasPrefix(".") || $0.contains("\\") || $0.contains("\0") }) { return nil }
        let base = root.standardizedFileURL.resolvingSymlinksInPath()
        let candidate = parts.reduce(base) { $0.appendingPathComponent($1) }.standardizedFileURL.resolvingSymlinksInPath()
        guard candidate.path.hasPrefix(base.path + "/") else { return nil }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory), !isDirectory.boolValue else { return nil }
        return candidate
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        running.insert(id)
        let request = task.request
        let root = rootProvider().standardizedFileURL.resolvingSymlinksInPath()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let reply = Self.reply(to: request, root: root)
            DispatchQueue.main.async {
                guard let self, self.running.remove(id) != nil else { return }
                task.didReceive(reply.response)
                if let body = reply.body { task.didReceive(body) }
                task.didFinish()
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        running.remove(ObjectIdentifier(task))
    }

    private static func reply(to request: URLRequest, root: URL) -> (response: HTTPURLResponse, body: Data?) {
        let url = request.url ?? startURL
        let method = request.httpMethod?.uppercased() ?? "GET"
        func plain(_ status: Int, _ text: String) -> (HTTPURLResponse, Data?) {
            let data = Data(text.utf8)
            let headers = ["Content-Type": "text/plain; charset=utf-8", "Content-Length": String(data.count), "Cache-Control": "no-store"]
            return (HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!, method == "HEAD" ? nil : data)
        }
        guard method == "GET" || method == "HEAD" else { return plain(405, "Method not allowed") }
        guard let file = file(for: url, root: root),
              let data = try? Data(contentsOf: file, options: .mappedIfSafe) else { return plain(404, "Not found") }
        let headers = [
            "Content-Type": mimeType(for: file),
            "Content-Length": String(data.count),
            "Cache-Control": "no-cache",
            "X-Content-Type-Options": "nosniff",
        ]
        return (HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!, method == "HEAD" ? nil : data)
    }
}
