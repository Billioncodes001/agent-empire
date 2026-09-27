import SwiftUI
import WebKit

@main struct AgentEmpireApp: App {
    var body: some Scene { WindowGroup { HostScreen() } }
}

enum HostPolicy {
    static func origin(_ value: String) -> String? {
        guard let url = URLComponents(string: value), url.scheme?.lowercased() == "https",
              let host = url.host, !host.isEmpty, url.user == nil, url.password == nil,
              url.port == nil || (1...65535).contains(url.port!) else { return nil }
        var clean = URLComponents(); clean.scheme = "https"; clean.host = host.lowercased()
        if let port = url.port, port != 443 { clean.port = port }
        return clean.string
    }
    static func validate(_ value: String) -> String? {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URLComponents(string: text), url.path.isEmpty || url.path == "/",
              url.query == nil, url.fragment == nil else { return nil }
        return origin(text)
    }
}

struct HostScreen: View {
    @AppStorage("hostOrigin") private var saved = ""
    @State private var entered = ""
    @State private var selected: String?
    @State private var error = ""
    @State private var status = ""
    @State private var reload = UUID()
    @State private var confirmForget = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let origin = selected {
                HStack {
                    Button("Hosts") { selected = nil }
                    Spacer()
                    Button("Reload") { reload = UUID() }
                }
                Text(status.isEmpty ? origin : status).font(.caption).textSelection(.enabled)
                HostWebView(origin: origin, reload: reload, status: $status)
            } else {
                Text("AGENT EMPIRE").font(.largeTitle.bold())
                Text("Your city, from your phone").font(.title2)
                Text("Connect to an existing Agent Empire host over HTTPS, then sign in on its login page. Only connect to a host you trust.")
                Text("This companion needs your host online. It does not include an offline world or run local agents. Accepted cloud jobs continue when you close it. Rotate to landscape for a wider view.").font(.callout).foregroundStyle(.secondary)
                TextField("https://city.example.com", text: $entered).textContentType(.URL).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled().textFieldStyle(.roundedBorder)
                Button("Connect to host") {
                    guard let origin = HostPolicy.validate(entered) else { error = "Enter an HTTPS host without a path, password, or token."; return }
                    saved = origin; status = origin; selected = origin; error = ""
                }.buttonStyle(.borderedProminent)
                Text(error).foregroundStyle(.orange)
                Button("Forget saved host and sessions") { confirmForget = true }
                Spacer()
            }
        }.padding().preferredColorScheme(.dark).onAppear { entered = saved }
        .confirmationDialog("Forget this phone's sessions? Host and cloud jobs keep running.", isPresented: $confirmForget) {
            Button("Forget", role: .destructive) {
                WKWebsiteDataStore.default().removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {}
                saved = ""; entered = ""; error = "Saved host and browser sessions cleared."
            }
        }
    }
}

struct HostWebView: UIViewRepresentable {
    let origin: String
    let reload: UUID
    @Binding var status: String

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.mediaTypesRequiringUserActionForPlayback = .all
        // No script handlers or native credential/filesystem bridge is exposed to the host.
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator; view.uiDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = true
        view.load(URLRequest(url: URL(string: origin + "/")!))
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.lastReload != reload { context.coordinator.lastReload = reload; context.coordinator.failed = false; view.load(URLRequest(url: URL(string: origin + "/")!)) }
    }
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) { view.stopLoading(); view.navigationDelegate = nil; view.uiDelegate = nil }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var parent: HostWebView
        var lastReload: UUID
        var failed = false
        init(_ parent: HostWebView) { self.parent = parent; self.lastReload = parent.reload }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url, HostPolicy.origin(url.absoluteString) == parent.origin, action.targetFrame != nil else {
                failed = true; parent.status = "Navigation outside your selected HTTPS host was blocked."; decisionHandler(.cancel); return
            }
            decisionHandler(.allow)
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { if !failed { parent.status = parent.origin } }
        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            guard let url = response.response.url, HostPolicy.origin(url.absoluteString) == parent.origin else {
                failed = true; parent.status = "Navigation outside your selected HTTPS host was blocked."; decisionHandler(.cancel); return
            }
            decisionHandler(.allow)
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed = true; parent.status = "Host unavailable or its certificate is invalid. Fix the connection, then reload." }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed = true; parent.status = "Connection interrupted. Keep the host online, then reload." }
        func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            // Keep Apple's normal TLS validation; never accept an untrusted certificate.
            if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust { completionHandler(.performDefaultHandling, nil) }
            else { completionHandler(.cancelAuthenticationChallenge, nil) }
        }
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) { decisionHandler(.deny) }
    }
}
