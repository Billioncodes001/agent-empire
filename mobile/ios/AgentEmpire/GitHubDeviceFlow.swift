import SwiftUI
import UIKit

/// GitHub's OAuth device flow, run natively because GitHub's token endpoints send no CORS headers.
/// Public client id only (no client secret exists in the app). The token is handed to the page, which decides
/// whether to keep it (secure.set); this type never stores it.
enum GitHubDeviceFlow {
    struct DeviceCode: Equatable {
        let deviceCode: String
        let userCode: String
        let verificationURL: URL
        let expiresAt: Date
        let interval: TimeInterval
    }

    enum Failure: Error, Equatable {
        case cancelled, expired, denied, disabled, network, badResponse, github(String)
        var message: String {
            switch self {
            case .cancelled: return "GitHub sign-in was cancelled."
            case .expired: return "The GitHub code expired. Start sign-in again."
            case .denied: return "GitHub sign-in was declined."
            case .disabled: return "GitHub sign-in isn't enabled for this app yet."
            case .network: return "Can't reach GitHub. Check your connection and try again."
            case .badResponse: return "GitHub sent an unexpected answer."
            case .github(let code): return "GitHub sign-in failed (\(code))."
            }
        }
    }

    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.timeoutIntervalForRequest = 20
        return URLSession(configuration: config)
    }()

    private static func form(_ url: URL, _ fields: [String: String]) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var parts = URLComponents()
        parts.queryItems = fields.map { URLQueryItem(name: $0.key, value: $0.value) }
        request.httpBody = Data((parts.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B").utf8)
        return request
    }

    private static func json(_ request: URLRequest) async throws -> [String: Any] {
        let data: Data
        do { (data, _) = try await session.data(for: request) } catch is CancellationError { throw Failure.cancelled } catch { throw Failure.network }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw Failure.badResponse }
        return obj
    }

    /// Step 1: ask GitHub for a user code.
    static func start(clientId: String, scopes: [String]) async throws -> DeviceCode {
        let obj = try await json(form(URL(string: "https://github.com/login/device/code")!, ["client_id": clientId, "scope": scopes.joined(separator: " ")]))
        if let error = obj["error"] as? String { throw error == "device_flow_disabled" ? Failure.disabled : Failure.github(error) }
        guard let deviceCode = obj["device_code"] as? String, let userCode = obj["user_code"] as? String,
              let uri = obj["verification_uri"] as? String, let url = URL(string: uri), url.scheme == "https", url.host?.hasSuffix("github.com") == true
        else { throw Failure.badResponse }
        let expires = (obj["expires_in"] as? Double) ?? 900
        let interval = max(5, (obj["interval"] as? Double) ?? 5)
        return DeviceCode(deviceCode: deviceCode, userCode: userCode, verificationURL: url, expiresAt: Date().addingTimeInterval(expires), interval: interval)
    }

    /// Step 2: poll until the player approves on GitHub (or declines, or the code expires).
    static func poll(clientId: String, code: DeviceCode) async throws -> String {
        var interval = code.interval
        while Date() < code.expiresAt {
            try await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            try Task.checkCancellation()
            let obj = try await json(form(URL(string: "https://github.com/login/oauth/access_token")!, [
                "client_id": clientId, "device_code": code.deviceCode, "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            ]))
            if let token = obj["access_token"] as? String, !token.isEmpty { return token }
            switch obj["error"] as? String {
            case "authorization_pending": continue
            case "slow_down": interval = max(interval + 5, (obj["interval"] as? Double) ?? 0)
            case "expired_token": throw Failure.expired
            case "access_denied": throw Failure.denied
            case "device_flow_disabled": throw Failure.disabled
            case let other?: throw Failure.github(other)
            case nil: throw Failure.badResponse
            }
        }
        throw Failure.expired
    }

    /// Step 3: who signed in.
    static func login(token: String) async throws -> String {
        var request = URLRequest(url: URL(string: "https://api.github.com/user")!)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        let obj = try await json(request)
        guard let login = obj["login"] as? String, !login.isEmpty else { throw Failure.badResponse }
        return login
    }
}

/// The native sheet: the user code, Copy, Open GitHub, and a live status. Presented over the game.
final class DeviceFlowModel: ObservableObject {
    enum Phase: Equatable { case requesting, waiting(GitHubDeviceFlow.DeviceCode), finishing }
    @Published var phase: Phase = .requesting
    @Published var copied = false
    let onCancel: () -> Void
    let onOpen: (URL) -> Void
    init(onCancel: @escaping () -> Void, onOpen: @escaping (URL) -> Void) {
        self.onCancel = onCancel
        self.onOpen = onOpen
    }
}

struct DeviceFlowSheet: View {
    @ObservedObject var model: DeviceFlowModel

    var body: some View {
        ZStack {
            Color.brandBackground.ignoresSafeArea()
            HStack(alignment: .center, spacing: 28) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Sign in with GitHub").font(.title2.weight(.bold)).foregroundStyle(Color.brandInk).accessibilityAddTraits(.isHeader)
                    Text("Enter this code on GitHub, approve Agent Empire, then come back here. Agent Empire asks for repository and workflow access.")
                        .font(.callout).foregroundStyle(Color.brandMuted).fixedSize(horizontal: false, vertical: true)
                    status.padding(.top, 6)
                }
                .frame(maxWidth: 360, alignment: .leading)
                VStack(spacing: 14) {
                    codeView
                    HStack(spacing: 12) {
                        Button { copy() } label: { Label(model.copied ? "Copied" : "Copy code", systemImage: model.copied ? "checkmark" : "doc.on.doc") }
                            .buttonStyle(.bordered).controlSize(.large).disabled(code == nil)
                        Button { if let url = code?.verificationURL { model.onOpen(url) } } label: { Label("Open GitHub", systemImage: "arrow.up.forward.app") }
                            .buttonStyle(.borderedProminent).controlSize(.large).disabled(code == nil)
                    }
                    Button("Cancel", role: .cancel) { model.onCancel() }.foregroundStyle(Color.brandMuted)
                }
            }
            .padding(24)
        }
        .preferredColorScheme(.dark)
        .tint(.brandAccent)
    }

    private var code: GitHubDeviceFlow.DeviceCode? {
        if case .waiting(let c) = model.phase { return c }
        return nil
    }

    @ViewBuilder private var codeView: some View {
        if let code {
            Text(code.userCode)
                .font(.system(size: 40, weight: .bold, design: .monospaced)).tracking(4)
                .foregroundStyle(Color.brandInk)
                .padding(.horizontal, 22).padding(.vertical, 12)
                .background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.07)))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.brandAccent.opacity(0.5)))
                .textSelection(.enabled)
                .accessibilityLabel("Code \(code.userCode.map(String.init).joined(separator: " "))")
        } else {
            ProgressView().controlSize(.large).frame(height: 70)
        }
    }

    @ViewBuilder private var status: some View {
        switch model.phase {
        case .requesting: Label("Asking GitHub for a code…", systemImage: "hourglass").font(.footnote).foregroundStyle(Color.brandMuted)
        case .waiting: Label("Waiting for you to approve on GitHub…", systemImage: "clock").font(.footnote).foregroundStyle(Color.brandAccent)
        case .finishing: Label("Approved. Finishing sign-in…", systemImage: "checkmark.circle").font(.footnote).foregroundStyle(Color.brandAccent)
        }
    }

    private func copy() {
        guard let code else { return }
        UIPasteboard.general.setItems([[UIPasteboard.typeAutomatic: code.userCode]], options: [.expirationDate: Date().addingTimeInterval(600)])
        model.copied = true
    }
}
