import Foundation

/// The two native calls the app makes before the game starts: a reachability probe and device sign-in.
/// No cookies, no cache, no redirects (a password is never forwarded to another host), and TLS is left to
/// Apple's default validation.
enum OfficeAPI {
    enum Failure: Error, Equatable {
        case untrusted, unreachable, insecureBlocked, notAnEmpire, wrongPassword, rateLimited, tooManyDevices, server(Int), badResponse

        var message: String {
            switch self {
            case .untrusted: return "This server's certificate isn't trusted, so the app won't connect to it. Check the address, or ask whoever runs the server to fix its HTTPS certificate."
            case .unreachable: return "Can't reach that server. Check the address and your connection, then try again."
            case .insecureBlocked: return "The connection was blocked because it isn't secure. Use the server's HTTPS address."
            case .notAnEmpire: return "That server didn't answer like an Agent Empire server. Check the address."
            case .wrongPassword: return "Wrong password."
            case .rateLimited: return "Too many sign-in attempts. Wait a few minutes and try again."
            case .tooManyDevices: return "This Empire has too many signed-in devices. Remove one in Settings on another device, then try again."
            case .server(let code): return "The server couldn't sign you in (error \(code)). Try again shortly."
            case .badResponse: return "The server sent an unexpected answer. Check that it runs a current Agent Empire version."
            }
        }
    }

    private final class NoRedirects: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }

    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 15
        config.waitsForConnectivity = false
        return URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
    }()

    static func map(_ error: Error) -> Failure {
        if let failure = error as? Failure { return failure }
        guard let e = error as? URLError else { return .unreachable }
        switch e.code {
        case .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateNotYetValid,
             .serverCertificateHasUnknownRoot, .clientCertificateRejected, .clientCertificateRequired, .secureConnectionFailed:
            return .untrusted
        case .appTransportSecurityRequiresSecureConnection:
            return .insecureBlocked
        default:
            return .unreachable
        }
    }

    /// GET /api/health must answer 200 {"ok":true}.
    static func probe(_ host: URL) async throws {
        var request = URLRequest(url: host.appendingPathComponent("api/health"))
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any], body["ok"] as? Bool == true
            else { throw Failure.notAnEmpire }
        } catch {
            throw map(error)
        }
    }

    /// POST /api/device/login {password, deviceName} → {token, deviceId}.
    static func signIn(host: URL, password: String, deviceName: String) async throws -> DeviceSession {
        var request = URLRequest(url: host.appendingPathComponent("api/device/login"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["password": password, "deviceName": deviceName])
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw Failure.badResponse }
            switch http.statusCode {
            case 200: break
            case 401: throw Failure.wrongPassword
            case 429: throw Failure.rateLimited
            case 409: throw Failure.tooManyDevices
            default: throw Failure.server(http.statusCode)
            }
            guard let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let token = body["token"] as? String, token.range(of: "^[A-Za-z0-9_-]{16,256}$", options: .regularExpression) != nil,
                  let deviceId = body["deviceId"] as? String, deviceId.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil
            else { throw Failure.badResponse }
            return DeviceSession(host: HostPolicy.originString(host), token: token, deviceId: deviceId)
        } catch {
            throw map(error)
        }
    }
}
