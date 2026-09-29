import SwiftUI
import UIKit

@main
struct AgentEmpireApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(model)
        }
    }
}

/// Orientation is chosen per screen: connect and sign-in follow the device, the game is landscape only.
final class AppDelegate: NSObject, UIApplicationDelegate {
    static var orientations: UIInterfaceOrientationMask = .allButUpsideDown

    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        Self.orientations
    }

    static func lock(_ mask: UIInterfaceOrientationMask) {
        orientations = mask
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            scene.keyWindow?.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { _ in }
        }
    }
}

extension Color {
    static let brandBackground = Color("LaunchBackground")
    static let brandInk = Color(red: 0.89, green: 0.91, blue: 0.91)
    static let brandMuted = Color(red: 0.62, green: 0.71, blue: 0.69)
    static let brandAccent = Color(red: 0.61, green: 0.82, blue: 0.73)
    static let brandWarn = Color(red: 0.95, green: 0.77, blue: 0.68)
}

@MainActor
final class AppModel: ObservableObject {
    enum Screen: Equatable {
        case connect
        case signIn(URL)
        case game(DeviceSession)
    }

    @Published private(set) var screen: Screen
    /// A one-line explanation shown on the connect screen after a sign-out.
    @Published var notice: String?
    @AppStorage("lastHost") var lastHost = ""

    init() {
        if let saved = Keychain.load() { screen = .game(saved) } else { screen = .connect }
    }

    func connected(to host: URL) {
        lastHost = HostPolicy.originString(host)
        notice = nil
        screen = .signIn(host)
    }

    func changeServer() {
        screen = .connect
    }

    func signedIn(_ session: DeviceSession) throws {
        try Keychain.save(session)
        screen = .game(session)
    }

    /// Called by the game bridge ("signedOut") or when the saved session can't be used. Always forgets the token.
    func signedOut(reason: String) {
        Keychain.clear()
        switch reason {
        case "user": notice = "Signed out. This device's sign-in was removed."
        case "revoked": notice = "This device was signed out from the Empire. Sign in again to continue."
        default: notice = "Your sign-in is no longer valid. Sign in again to continue."
        }
        screen = .connect
    }
}

struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ZStack {
            Color.brandBackground.ignoresSafeArea()
            switch model.screen {
            case .connect:
                ConnectView()
            case .signIn(let host):
                SignInView(host: host)
            case .game(let session):
                GameScreen(session: session)
            }
        }
        .preferredColorScheme(.dark)
        .tint(.brandAccent)
        .onChange(of: model.screen) { screen in
            if case .game = screen { AppDelegate.lock(.landscape) } else { AppDelegate.lock(.allButUpsideDown) }
        }
        .onAppear {
            if case .game = model.screen { AppDelegate.lock(.landscape) }
        }
    }
}
