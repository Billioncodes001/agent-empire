import SwiftUI
import UIKit

/// Launch screen → the bundled game immediately. The first-launch setup (mode choice, server sign-in, cloud
/// accounts) lives in the game itself (src/client/setup), talking to this shell through the native bridge.
@main
struct AgentEmpireApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    init() {
        SecureStore.migrateLegacySession()
    }

    var body: some Scene {
        WindowGroup {
            GameScreen()
                .preferredColorScheme(.dark)
                .tint(.brandAccent)
        }
    }
}

/// The game and its setup are landscape only.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        .landscape
    }
}

extension Color {
    static let brandBackground = Color("LaunchBackground")
    static let brandInk = Color(red: 0.89, green: 0.91, blue: 0.91)
    static let brandMuted = Color(red: 0.62, green: 0.71, blue: 0.69)
    static let brandAccent = Color(red: 0.61, green: 0.82, blue: 0.73)
    static let brandWarn = Color(red: 0.95, green: 0.77, blue: 0.68)
}
