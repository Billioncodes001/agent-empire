import SwiftUI
import UIKit
import WebKit

/// The game: full screen, landscape, no status bar, home indicator auto-hidden, system edge gestures deferred.
struct GameScreen: View {
    var body: some View {
        ZStack {
            Color.brandBackground.ignoresSafeArea()
            if let root = GameSchemeHandler.bundledRoot {
                GameWebView(root: root).ignoresSafeArea()
            } else {
                MissingGameView()
            }
        }
        .statusBarHidden(true)
        .persistentSystemOverlays(.hidden)
        .defersSystemGestures(on: .all)
    }
}

/// Shown only when a build was made without copying the web client into the app.
struct MissingGameView: View {
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.triangle.fill").font(.largeTitle).foregroundStyle(Color.brandWarn)
            Text("The game files are missing from this build.").font(.headline).foregroundStyle(Color.brandInk)
            Text("Run npm run build:client, then build the app again.").font(.callout).foregroundStyle(Color.brandMuted)
        }
        .padding()
    }
}

struct GameWebView: UIViewControllerRepresentable {
    let root: URL

    func makeUIViewController(context: Context) -> GameViewController { GameViewController(root: root) }
    func updateUIViewController(_ controller: GameViewController, context: Context) {}
    static func dismantleUIViewController(_ controller: GameViewController, coordinator: ()) { controller.tearDown() }
}

/// Holds only a weak reference, so the content controller doesn't keep the game alive.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

#if DEBUG
/// Debug builds only: page errors, rejections, console.error lines, and where touches and clicks land (to check
/// simulator tap coordinates) go to the simulator log as `AEPage …`. Never in Release.
private final class DebugLog: NSObject, WKScriptMessageHandler {
    static let script = "(()=>{const h=window.webkit.messageHandlers.empireDebug;const s=(m)=>{try{h.postMessage(String(m).slice(0,800))}catch{}};addEventListener('error',e=>s('error: '+e.message+' @'+e.filename+':'+e.lineno));addEventListener('unhandledrejection',e=>s('rejection: '+(e.reason&&e.reason.stack||e.reason)));const ce=console.error.bind(console);console.error=(...a)=>{s('console.error: '+a.join(' '));ce(...a)};addEventListener('touchstart',e=>{const t=e.touches[0];s('touch '+Math.round(t.clientX)+','+Math.round(t.clientY)+' on '+(e.target&&e.target.className)+' viewport '+innerWidth+'x'+innerHeight)},{capture:true,passive:true});addEventListener('click',e=>s('click on '+(e.target&&e.target.className)),true);})();"
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        NSLog("AEPage %@", String(describing: message.body))
    }
}
#endif

/// Records when the player last touched the game, without taking part in any gesture. Used to tell a link the
/// player tapped from one a script opened on its own.
private final class TouchRecorder: UIGestureRecognizer {
    var gate = BridgeProtocol.GestureGate()
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        gate.touched()
        state = .failed
    }
}

final class GameViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, UIGestureRecognizerDelegate {
    /// The single native message channel the page can use: window.webkit.messageHandlers.empire.
    static let bridgeName = "empire"
    static let brand = UIColor(red: 0x0F / 255, green: 0x1B / 255, blue: 0x21 / 255, alpha: 1)

    private let root: URL
    private var webView: WKWebView?
    private let touches = TouchRecorder()
    /// Why the last session ended; shown once by the setup's sign-in step after the reload.
    private var signedOutReason: String?
    private var deviceFlowTask: Task<Void, Never>?
    /// In-app game updates (REL-04): installed bundles, the 20 s rollback timer.
    private let updater: GameUpdater
    private var trialTimer: Timer?

    init(root: URL) {
        self.root = root
        updater = GameUpdater.standard(builtinRoot: root)
        let info = Bundle.main.infoDictionary ?? [:]
        updater.shellVersion = UpdatePolicy.shellVersion(marketing: info["CFBundleShortVersionString"] as? String, build: info["CFBundleVersion"] as? String)
        // A pending bundle switches in now (a trial until the page reports booting); an unfinished trial rolls back.
        updater.launch()
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// The config the page reads before it starts, from what is in secure storage right now.
    private func configScript() -> String {
        BridgeProtocol.configScript(deviceName: UIDevice.current.name, mode: SecureStore.get(.mode), host: SecureStore.get(.serverHost),
                                    token: SecureStore.get(.serverToken), deviceId: SecureStore.get(.serverDeviceId), signedOut: signedOutReason)
    }

    /// Re-injects the config for the next page load (after a sign-in, a sign-out or a web content process restart).
    private func refreshConfig() {
        guard let controller = webView?.configuration.userContentController else { return }
        controller.removeAllUserScripts()
        installScripts(controller)
    }

    private func installScripts(_ controller: WKUserContentController) {
        controller.addUserScript(WKUserScript(source: configScript(), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #if DEBUG
        controller.addUserScript(WKUserScript(source: DebugLog.script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #endif
    }

    override func loadView() {
        let config = WKWebViewConfiguration()
        let updater = self.updater, builtin = root
        config.setURLSchemeHandler(GameSchemeHandler(rootProvider: { updater.servingRoot() ?? builtin }), forURLScheme: GameSchemeHandler.scheme)
        config.websiteDataStore = .default() // keeps the player's profile and settings between launches
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsAirPlayForMediaPlayback = false
        config.allowsPictureInPictureMediaPlayback = false
        config.dataDetectorTypes = []
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.preferences.isTextInteractionEnabled = true
        installScripts(config.userContentController)
        config.userContentController.add(WeakMessageHandler(self), contentWorld: .page, name: Self.bridgeName)
        #if DEBUG
        config.userContentController.add(DebugLog(), name: "empireDebug") // Debug only: page errors reach the simulator log
        #endif

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = Self.brand
        webView.underPageBackgroundColor = Self.brand
        webView.scrollView.backgroundColor = Self.brand
        // Keep the default inset adjustment: with viewport-fit=cover (index.html) the page stays edge to edge and WebKit
        // reports the Dynamic Island / home indicator clearance through env(safe-area-inset-*). `.never` zeroes them.
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        webView.allowsLinkPreview = false
        webView.allowsBackForwardNavigationGestures = false
        webView.navigationDelegate = self
        webView.uiDelegate = self
        touches.cancelsTouchesInView = false
        touches.delaysTouchesBegan = false
        touches.delegate = self
        webView.addGestureRecognizer(touches)
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
        armTrial()
        webView?.load(URLRequest(url: GameSchemeHandler.startURL))
    }

    // MARK: In-app updates (REL-04)

    /// While a new bundle is on trial, roll back if the page hasn't reported booting 20 s after it started.
    private func armTrial() {
        trialTimer?.invalidate()
        guard let remaining = updater.trialRemaining else { return }
        trialTimer = Timer.scheduledTimer(withTimeInterval: remaining + 0.05, repeats: false) { [weak self] _ in
            guard let self, self.updater.checkTrial() else { return }
            NSLog("AgentEmpire: the updated game did not report booting within 20 s; rolled back")
            self.refreshConfig()
            self.webView?.load(URLRequest(url: GameSchemeHandler.startURL))
        }
    }

    /// iOS TestFlight builds carry a sandbox receipt; Debug builds are development installs.
    private var installSource: String {
        #if DEBUG
        return "development"
        #else
        return Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt" ? "testflight" : "appstore"
        #endif
    }

    private func nativeInfo() -> [String: Any] {
        let info = Bundle.main.infoDictionary ?? [:]
        var out: [String: Any] = [
            "platform": "ios",
            "shellVersion": UpdatePolicy.shellVersion(marketing: info["CFBundleShortVersionString"] as? String, build: info["CFBundleVersion"] as? String) ?? NSNull(),
            "installedGame": updater.installedGame ?? NSNull(),
            "builtinGame": updater.builtinVersion ?? NSNull(),
            "pendingGame": updater.pendingGame ?? NSNull(),
            "canInstallGame": true,
            "canAutoUpdate": false,
            "installSource": installSource,
        ]
        if let back = updater.takeRolledBack() { out["rolledBack"] = back }
        if let dev = UpdatePolicy.devReleasePublicKey { out["devReleaseKey"] = dev } // Debug builds only (REL-07)
        return out
    }

    private func message(_ error: Error, _ fallback: String) -> String {
        if let failure = error as? GameUpdater.Failure { return failure.description }
        if (error as? URLError) != nil { return "GitHub could not be reached." }
        return fallback
    }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .all }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

    func tearDown() {
        deviceFlowTask?.cancel()
        trialTimer?.invalidate()
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

    // MARK: Bridge (docs/team/CLOUD_MODE_PLAN.md): only requests from the game's own main frame are answered.

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.name == Self.bridgeName, message.frameInfo.isMainFrame,
              origin.protocol == GameSchemeHandler.scheme, origin.host == GameSchemeHandler.host else { return }
        switch BridgeProtocol.parse(message.body) {
        case .failure: return // no id to answer; the page's own timeout reports it
        case .success(let request): handle(request)
        }
    }

    private func resolve(_ id: String, _ result: Any?) {
        webView?.evaluateJavaScript(BridgeProtocol.resolveScript(id: id, result: result), completionHandler: nil)
    }

    private func reject(_ id: String, _ message: String) {
        webView?.evaluateJavaScript(BridgeProtocol.rejectScript(id: id, message: message), completionHandler: nil)
    }

    private func handle(_ request: BridgeProtocol.Request) {
        let id = request.id
        switch request.method {
        case .secureGet:
            switch BridgeProtocol.key(request.params) {
            case .failure(let f): reject(id, f.message)
            case .success(let key): resolve(id, SecureStore.get(key))
            }
        case .secureSet:
            guard case .success(let key) = BridgeProtocol.key(request.params) else { return reject(id, BridgeProtocol.Failure.badKey.message) }
            switch BridgeProtocol.validate(key, value: request.params["value"]) {
            case .failure(let f): reject(id, f.message)
            case .success(let value):
                do {
                    try SecureStore.set(key, value)
                    if key == .serverToken { signedOutReason = nil }
                    refreshConfig()
                    resolve(id, true)
                } catch {
                    reject(id, "This device couldn't store that securely.")
                }
            }
        case .secureDelete:
            switch BridgeProtocol.key(request.params) {
            case .failure(let f): reject(id, f.message)
            case .success(let key):
                SecureStore.delete(key)
                refreshConfig()
                resolve(id, true)
            }
        case .githubDeviceFlow:
            switch BridgeProtocol.deviceFlow(request.params) {
            case .failure(let f): reject(id, f.message)
            case .success(let args): runDeviceFlow(id: id, clientId: args.clientId, scopes: args.scopes)
            }
        case .signedOut:
            let reason = (try? BridgeProtocol.reason(request.params).get()) ?? "unauthorized"
            resolve(id, true)
            signOut(reason: reason)
        case .updateFetch:
            switch BridgeProtocol.updateFetch(request.params) {
            case .failure(let f): reject(id, f.message)
            case .success(let args):
                Task { @MainActor [weak self, updater] in
                    do {
                        let r = try await updater.fetch(args.url, etag: args.etag)
                        self?.resolve(id, ["status": r.status, "body": String(decoding: r.body, as: UTF8.self), "etag": r.etag ?? NSNull()])
                    } catch {
                        self?.reject(id, self?.message(error, "The download failed.") ?? "The download failed.")
                    }
                }
            }
        case .updateInstallGame:
            switch BridgeProtocol.installGame(request.params) {
            case .failure(let f): reject(id, f.message)
            case .success(let args):
                Task { @MainActor [weak self, updater] in
                    do {
                        let version = try await updater.installGame(url: args.url, sha256: args.sha256, version: args.version)
                        self?.resolve(id, ["version": version])
                    } catch {
                        self?.reject(id, self?.message(error, "The update could not be installed.") ?? "The update could not be installed.")
                    }
                }
            }
        case .updateActivate:
            guard updater.activate() else { return reject(id, "No update is waiting.") }
            resolve(id, true)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                self.armTrial()
                self.refreshConfig()
                self.webView?.load(URLRequest(url: GameSchemeHandler.startURL))
            }
        case .updateBootOk:
            updater.bootOk()
            trialTimer?.invalidate()
            resolve(id, true)
        case .updateNativeInfo:
            resolve(id, nativeInfo())
        case .updateOpenNative:
            switch BridgeProtocol.storeURL(request.params) {
            case .failure(let f): reject(id, f.message)
            case .success(let url):
                if touches.gate.consume() {
                    UIApplication.shared.open(url)
                    resolve(id, ["action": "store"])
                } else {
                    offerExternal(url) { opened in opened ? self.resolve(id, ["action": "store"]) : self.reject(id, "Not opened.") }
                }
            }
        case .openExternal:
            switch BridgeProtocol.externalURL(request.params) {
            case .failure(let f): reject(id, f.message)
            case .success(let url):
                // Straight to Safari right after a tap (one page per tap); anything else asks first.
                if touches.gate.consume() {
                    UIApplication.shared.open(url)
                    resolve(id, true)
                } else {
                    offerExternal(url) { opened in opened ? self.resolve(id, true) : self.reject(id, "Not opened.") }
                }
            }
        }
    }

    /// The session ended: forget every credential (server device token and id, GitHub token and login; the chosen
    /// mode, server address and state repository stay for the sign-in step), then reload so the setup shows why.
    private func signOut(reason: String) {
        for key in BridgeProtocol.sessionKeys { SecureStore.delete(key) }
        signedOutReason = reason
        refreshConfig()
        DispatchQueue.main.async { self.webView?.load(URLRequest(url: GameSchemeHandler.startURL)) }
    }

    private func runDeviceFlow(id: String, clientId: String, scopes: [String]) {
        guard deviceFlowTask == nil, presentedViewController == nil else { return reject(id, "GitHub sign-in is already open.") }
        var sheet: UIViewController?
        let model = DeviceFlowModel(onCancel: { [weak self] in self?.deviceFlowTask?.cancel() }, onOpen: { url in UIApplication.shared.open(url) })
        let host = UIHostingController(rootView: DeviceFlowSheet(model: model))
        host.modalPresentationStyle = .fullScreen
        host.view.backgroundColor = Self.brand
        sheet = host
        present(host, animated: true)
        deviceFlowTask = Task { @MainActor [weak self] in
            defer {
                sheet?.dismiss(animated: true)
                self?.deviceFlowTask = nil
            }
            do {
                let code = try await GitHubDeviceFlow.start(clientId: clientId, scopes: scopes)
                model.phase = .waiting(code)
                let token = try await GitHubDeviceFlow.poll(clientId: clientId, code: code)
                model.phase = .finishing
                let login = try await GitHubDeviceFlow.login(token: token)
                self?.resolve(id, ["token": token, "login": login])
            } catch let failure as GitHubDeviceFlow.Failure {
                self?.reject(id, failure.message)
            } catch is CancellationError {
                self?.reject(id, GitHubDeviceFlow.Failure.cancelled.message)
            } catch {
                self?.reject(id, GitHubDeviceFlow.Failure.network.message)
            }
        }
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
        // window.open / target=_blank: never a new web view; ask before leaving the app.
        if let url = action.request.url { offerExternal(url) }
        return nil
    }

    /// External https links open in Safari only after the player confirms. Nothing else leaves the app.
    private func offerExternal(_ url: URL, done: ((Bool) -> Void)? = nil) {
        guard url.scheme?.lowercased() == "https", let host = url.host, presentedViewController == nil else { done?(false); return }
        let alert = UIAlertController(title: "Open in Safari?", message: host, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in done?(false) })
        alert.addAction(UIAlertAction(title: "Open", style: .default) { _ in
            UIApplication.shared.open(url)
            done?(true)
        })
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

    #if DEBUG
    /// Debug builds log the insets the page sees, to check Dynamic Island and home indicator clearance.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let probe = "(()=>{const d=document.createElement('div');d.style.cssText='position:fixed;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';document.body.append(d);const c=getComputedStyle(d);const r=[c.paddingTop,c.paddingRight,c.paddingBottom,c.paddingLeft,innerWidth+'x'+innerHeight,isSecureContext].join(' ');d.remove();return r})()"
        for delay in [0.0, 4.0] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                webView.evaluateJavaScript(probe) { value, _ in
                    NSLog("AEInsets +%.0fs native=%@ page=%@", delay, NSCoder.string(for: webView.safeAreaInsets), String(describing: value ?? "nil"))
                }
            }
        }
    }
    #endif

    /// If the web content process dies (memory pressure), bring the game back rather than leave a blank screen.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        refreshConfig()
        webView.load(URLRequest(url: GameSchemeHandler.startURL))
    }
}
