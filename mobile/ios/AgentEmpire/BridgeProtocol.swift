import Foundation

/// The native side of the bridge contract (docs/team/CLOUD_MODE_PLAN.md, "Native bridge contract"), as pure
/// Foundation code so the Mac-side checks (Checks/run.sh) can exercise it without a simulator.
///
/// Page → app: `webkit.messageHandlers.empire.postMessage({id, method, params})`.
/// App → page: `window.__empireNative.resolve(id, result)` or `window.__empireNative.reject(id, message)`.
enum BridgeProtocol {
    enum Method: String {
        case secureGet = "secure.get"
        case secureSet = "secure.set"
        case secureDelete = "secure.delete"
        case githubDeviceFlow = "github.deviceFlow"
        case signedOut = "app.signedOut"
        case openExternal = "app.openExternal"
    }

    /// The only keys stored for the page. Provider API keys are never among them.
    enum Key: String, CaseIterable {
        case mode
        case serverHost = "server.host"
        case serverToken = "server.token"
        case serverDeviceId = "server.deviceId"
        case githubToken = "github.token"
        case githubLogin = "github.login"
        case stateRepo = "state.repo"
    }

    struct Request {
        let id: String
        let method: Method
        let params: [String: Any]
    }

    enum Failure: Error, Equatable {
        case malformed, unknownMethod, badId
        case badKey, badValue(String), badScopes, badClientId, badURL, badReason
        var message: String {
            switch self {
            case .malformed: return "Malformed request."
            case .unknownMethod: return "Unknown request."
            case .badId: return "Malformed request id."
            case .badKey: return "That key can't be stored."
            case .badValue(let why): return why
            case .badScopes: return "Unsupported GitHub permissions requested."
            case .badClientId: return "GitHub sign-in is not configured in this build."
            case .badURL: return "Only https links can be opened."
            case .badReason: return "Unknown sign-out reason."
            }
        }
    }

    static let maxValueLength = 8192
    static let githubScopes: Set<String> = ["repo", "workflow", "read:user"]
    static let signOutReasons: Set<String> = ["user", "revoked", "unauthorized"]
    private static let idPattern = "^[A-Za-z0-9_-]{1,64}$"
    private static let clientIdPattern = "^[A-Za-z0-9._-]{1,64}$"
    private static let tokenPattern = "^[A-Za-z0-9_-]{16,256}$"
    private static let deviceIdPattern = "^[A-Za-z0-9_-]{1,128}$"
    private static let loginPattern = "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$"
    private static let repoPattern = "^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$"

    static func matches(_ s: String, _ pattern: String) -> Bool { s.range(of: pattern, options: .regularExpression) != nil }

    static func parse(_ body: Any) -> Result<Request, Failure> {
        guard let dict = body as? [String: Any] else { return .failure(.malformed) }
        guard let id = dict["id"] as? String, matches(id, idPattern) else { return .failure(.badId) }
        guard let name = dict["method"] as? String, let method = Method(rawValue: name) else { return .failure(.unknownMethod) }
        let params = dict["params"] as? [String: Any] ?? [:]
        return .success(Request(id: id, method: method, params: params))
    }

    static func key(_ params: [String: Any]) -> Result<Key, Failure> {
        guard let raw = params["key"] as? String, let key = Key(rawValue: raw) else { return .failure(.badKey) }
        return .success(key)
    }

    /// What may be stored under each key. Anything else is refused before it reaches the Keychain.
    static func validate(_ key: Key, value: Any?, allowLoopbackHTTP: Bool = HostPolicy.allowsLoopbackHTTP) -> Result<String, Failure> {
        guard let value = value as? String, !value.isEmpty, value.count <= maxValueLength else { return .failure(.badValue("That value can't be stored.")) }
        switch key {
        case .mode:
            return ["cloud", "server"].contains(value) ? .success(value) : .failure(.badValue("Unknown mode."))
        case .serverHost:
            guard case .success(let url) = HostPolicy.origin(from: value, allowLoopbackHTTP: allowLoopbackHTTP), HostPolicy.originString(url) == value
            else { return .failure(.badValue("That server address isn't allowed in this build.")) }
            return .success(value)
        case .serverToken:
            return matches(value, tokenPattern) ? .success(value) : .failure(.badValue("Malformed device token."))
        case .serverDeviceId:
            return matches(value, deviceIdPattern) ? .success(value) : .failure(.badValue("Malformed device id."))
        case .githubToken:
            return value.rangeOfCharacter(from: .whitespacesAndNewlines) == nil && value.count <= 512 ? .success(value) : .failure(.badValue("Malformed GitHub token."))
        case .githubLogin:
            return matches(value, loginPattern) ? .success(value) : .failure(.badValue("Malformed GitHub login."))
        case .stateRepo:
            return matches(value, repoPattern) ? .success(value) : .failure(.badValue("Malformed repository name."))
        }
    }

    static func deviceFlow(_ params: [String: Any]) -> Result<(clientId: String, scopes: [String]), Failure> {
        guard let clientId = params["clientId"] as? String, matches(clientId, clientIdPattern) else { return .failure(.badClientId) }
        guard let scopes = params["scopes"] as? [String], !scopes.isEmpty, scopes.allSatisfy({ githubScopes.contains($0) }) else { return .failure(.badScopes) }
        var seen = Set<String>()
        return .success((clientId, scopes.filter { seen.insert($0).inserted }))
    }

    static func externalURL(_ params: [String: Any]) -> Result<URL, Failure> {
        guard let raw = params["url"] as? String, let parts = URLComponents(string: raw), parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil, let url = parts.url
        else { return .failure(.badURL) }
        return .success(url)
    }

    static func reason(_ params: [String: Any]) -> Result<String, Failure> {
        guard let r = params["reason"] as? String, signOutReasons.contains(r) else { return .failure(.badReason) }
        return .success(r)
    }

    /// JSON literal for a value (strings, numbers, booleans, null, arrays and dictionaries of those).
    static func json(_ value: Any?) -> String {
        guard let value, !(value is NSNull) else { return "null" }
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys]),
              let s = String(data: data, encoding: .utf8) else { return "null" }
        // U+2028/2029 are valid in JSON but end a JavaScript line in older engines.
        return s.replacingOccurrences(of: "\u{2028}", with: "\\u2028").replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }

    static func resolveScript(id: String, result: Any?) -> String {
        "window.__empireNative&&window.__empireNative.resolve(\(json(id)),\(json(result)));"
    }

    static func rejectScript(id: String, message: String) -> String {
        "window.__empireNative&&window.__empireNative.reject(\(json(id)),\(json(message)));"
    }

    /// What the page reads before it starts (src/client/native.ts, src/client/endpoint.ts): the platform, the stored
    /// mode and, only for a valid server session, its host/token/device id. Frozen and non-enumerable on window.
    static func configScript(deviceName: String, mode: String?, host: String?, token: String?, deviceId: String?, signedOut: String?,
                             allowLoopbackHTTP: Bool = HostPolicy.allowsLoopbackHTTP) -> String {
        var payload: [String: Any] = ["platform": "ios", "deviceName": String(deviceName.prefix(64))]
        if let mode, ["cloud", "server"].contains(mode) { payload["mode"] = mode }
        if mode == "server", let host, case .success = validate(.serverHost, value: host, allowLoopbackHTTP: allowLoopbackHTTP),
           let token, matches(token, tokenPattern) {
            payload["host"] = host
            payload["token"] = token
            if let deviceId, matches(deviceId, deviceIdPattern) { payload["deviceId"] = deviceId }
        }
        if let signedOut, signOutReasons.contains(signedOut) { payload["signedOut"] = signedOut }
        return "Object.defineProperty(window,'AGENT_EMPIRE_APP',{value:Object.freeze(\(json(payload))),writable:false,configurable:false,enumerable:false});"
    }
}
