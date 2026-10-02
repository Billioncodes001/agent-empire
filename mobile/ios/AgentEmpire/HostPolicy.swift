import Foundation

/// Which server addresses the app will talk to. Release builds require HTTPS. Debug builds also accept plain
/// http:// on the loopback host, so the simulator can reach a local test fixture; never another host.
enum HostPolicy {
    enum Rejection: Error, Equatable {
        case empty, malformed, notHTTPS, hasPath, hasCredentials
        var message: String {
            switch self {
            case .empty: return "Enter your Empire server address."
            case .malformed: return "That doesn't look like a server address."
            case .notHTTPS: return "The server must use HTTPS."
            case .hasPath: return "Enter only the server address, without a path, query or token."
            case .hasCredentials: return "Don't put a user name or password in the address."
            }
        }
    }

    #if DEBUG
    static let allowsLoopbackHTTP = true
    #else
    static let allowsLoopbackHTTP = false
    #endif

    static let loopbackHosts: Set<String> = ["localhost", "127.0.0.1", "::1", "[::1]"]

    /// Returns the bare origin (scheme, host, optional port) or why the input was refused.
    /// "city.example.com" is read as https://city.example.com.
    static func origin(from input: String, allowLoopbackHTTP: Bool = allowsLoopbackHTTP) -> Result<URL, Rejection> {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return .failure(.empty) }
        if !text.contains("://") { text = "https://" + text }
        guard let parts = URLComponents(string: text), let scheme = parts.scheme?.lowercased(),
              let host = parts.host?.lowercased(), !host.isEmpty else { return .failure(.malformed) }
        if parts.user != nil || parts.password != nil { return .failure(.hasCredentials) }
        if !(parts.path.isEmpty || parts.path == "/") || parts.query != nil || parts.fragment != nil { return .failure(.hasPath) }
        if let port = parts.port, !(1...65535).contains(port) { return .failure(.malformed) }
        switch scheme {
        case "https": break
        case "http" where allowLoopbackHTTP && loopbackHosts.contains(host): break
        case "http": return .failure(.notHTTPS)
        default: return .failure(.malformed)
        }
        var clean = URLComponents()
        clean.scheme = scheme
        clean.host = host
        if let port = parts.port, !(scheme == "https" && port == 443), !(scheme == "http" && port == 80) { clean.port = port }
        guard let url = clean.url else { return .failure(.malformed) }
        return .success(url)
    }

    /// The origin string the web client expects in `AGENT_EMPIRE_APP.host` (no trailing slash).
    static func originString(_ url: URL) -> String {
        var s = url.absoluteString
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }
}
