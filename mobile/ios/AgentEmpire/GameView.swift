import SwiftUI
import UIKit
import WebKit

/// The game: full screen, landscape, no status bar, home indicator auto-hidden, system edge gestures deferred.
struct GameScreen: View {
    @EnvironmentObject private var model: AppModel
    let session: DeviceSession

    var body: some View {
        Group {
            if let root = GameSchemeHandler.bundledRoot {
                GameWebView(session: session, root: root) { reason in model.signedOut(reason: reason) }
                    .ignoresSafeArea()
            } else {
                MissingGameView { model.signedOut(reason: "user") }
            }
        }
        .statusBarHidden(true)
        .persistentSystemOverlays(.hidden)
        .defersSystemGestures(on: .all)
    }
}

/// Shown only when a build was made without copying the web client into the app.
struct MissingGameView: View {
    let signOut: () -> Void
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.triangle.fill").font(.largeTitle).foregroundStyle(Color.brandWarn)
            Text("The game files are missing from this build.").font(.headline).foregroundStyle(Color.brandInk)
            Text("Run npm run build:client, then build the app again.").font(.callout).foregroundStyle(Color.brandMuted)
            Button("Sign out", action: signOut)
        }
        .padding()
    }
}

struct GameWebView: UIViewControllerRepresentable {
    let session: DeviceSession
    let root: URL
    let onSignedOut: (String) -> Void

    func makeUIViewController(context: Context) -> GameViewController {
        GameViewController(session: session, root: root, onSignedOut: onSignedOut)
    }

    func updateUIViewController(_ controller: GameViewController, context: Context) {}

    static func dismantleUIViewController(_ controller: GameViewController, coordinator: ()) {
        controller.tearDown()
    }
}

/// Holds only a weak reference, so the content controller doesn't keep the game alive.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

final class GameViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    /// The single native message channel the page can use: window.webkit.messageHandlers.empire.
    static let bridgeName = "empire"
    static let signOutReasons: Set<String> = ["user", "revoked", "unauthorized"]
    static let brand = UIColor(red: 0x0F / 255, green: 0x1B / 255, blue: 0x21 / 255, alpha: 1)

    private let session: DeviceSession
    private let root: URL
    private let onSignedOut: (String) -> Void
    private var webView: WKWebView?

    init(session: DeviceSession, root: URL, onSignedOut: @escaping (String) -> Void) {
        self.session = session
        self.root = root
        self.onSignedOut = onSignedOut
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// The config the web client reads before it starts (see src/client/endpoint.ts). JSON-encoded, so no value
    /// can break out of the literal; read-only and non-enumerable on window.
    static func configScript(for session: DeviceSession) -> String {
        let payload = ["host": session.host, "token": session.token, "platform": "ios", "deviceId": session.deviceId]
        let json = (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])).flatMap { String(data: $0, encoding: .utf8) } ?? "null"
        return "Object.defineProperty(window,'AGENT_EMPIRE_APP',{value:Object.freeze(\(json)),writable:false,configurable:false,enumerable:false});"
    }

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(GameSchemeHandler(root: root), forURLScheme: GameSchemeHandler.scheme)
        config.websiteDataStore = .default() // keeps the player's profile and settings between launches
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsAirPlayForMediaPlayback = false
        config.allowsPictureInPictureMediaPlayback = false
        config.dataDetectorTypes = []
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.preferences.isTextInteractionEnabled = true
        config.userContentController.addUserScript(WKUserScript(source: Self.configScript(for: session), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.add(WeakMessageHandler(self), contentWorld: .page, name: Self.bridgeName)

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = Self.brand
        webView.underPageBackgroundColor = Self.brand
        webView.scrollView.backgroundColor = Self.brand
        webView.scrollView.contentInsetAdjustmentBehavior = .never // content is edge to edge; the page uses env(safe-area-inset-*)
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        webView.allowsLinkPreview = false
        webView.allowsBackForwardNavigationGestures = false
        webView.navigationDelegate = self
        webView.uiDelegate = self
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
        self.webView = webView

        let container = UIView()
        container.backgroundColor = Self.brand
        webView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        view = container
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        webView?.load(URLRequest(url: GameSchemeHandler.startURL))
    }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .all }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }

    func tearDown() {
        guard let webView else { return }
        webView.configuration.userContentController.removeAllScriptMessageHandlers()
        webView.configuration.userContentController.removeAllUserScripts()
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        self.webView = nil
    }

    private static func isGame(_ url: URL?) -> Bool {
        url?.scheme?.lowercased() == GameSchemeHandler.scheme && url?.host?.lowercased() == GameSchemeHandler.host
    }

    // MARK: Bridge: only {type: "signedOut", reason} from the game's own main frame is accepted.

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.name == Self.bridgeName, message.frameInfo.isMainFrame,
              origin.protocol == GameSchemeHandler.scheme, origin.host == GameSchemeHandler.host,
              let body = message.body as? [String: Any], body["type"] as? String == "signedOut" else { return }
        let reason = body["reason"] as? String ?? "unauthorized"
        tearDown()
        onSignedOut(Self.signOutReasons.contains(reason) ? reason : "unauthorized")
    }

    // MARK: Navigation: the web view only ever shows the bundled game.

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url
        if Self.isGame(url) { return decisionHandler(.allow) }
        // Blank or srcdoc sub-frames carry no remote content.
        if let url, action.targetFrame?.isMainFrame == false, url.scheme == "about" { return decisionHandler(.allow) }
        decisionHandler(.cancel)
        if action.navigationType == .linkActivated, let url { offerExternal(url) }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        // window.open / target=_blank (e.g. a pull request link): never a new web view; ask before leaving the app.
        if let url = action.request.url { offerExternal(url) }
        return nil
    }

    /// External https links open in Safari only after the player confirms. Nothing else leaves the app.
    private func offerExternal(_ url: URL) {
        guard url.scheme?.lowercased() == "https", let host = url.host, presentedViewController == nil else { return }
        let alert = UIAlertController(title: "Open in Safari?", message: host, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Open", style: .default) { _ in UIApplication.shared.open(url) })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }

    func webView(_ webView: WKWebView, requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        if presentedViewController == nil { present(alert, animated: true) } else { completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        if presentedViewController == nil { present(alert, animated: true) } else { completionHandler(false) }
    }

    /// If the web content process dies (memory pressure), bring the game back rather than leave a blank screen.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.load(URLRequest(url: GameSchemeHandler.startURL))
    }
}
