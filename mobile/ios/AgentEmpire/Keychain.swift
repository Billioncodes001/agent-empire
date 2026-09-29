import Foundation
import Security

/// The signed-in device: which server, its device token and device id. Kept only in the Keychain,
/// readable after first unlock and never synced or migrated to another device. Never logged.
struct DeviceSession: Codable, Equatable {
    let host: String
    let token: String
    let deviceId: String
}

enum Keychain {
    private static let service = "com.agentempire.mobile.device-session"
    private static let account = "current"

    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    enum Failure: Error { case status(OSStatus) }

    static func save(_ session: DeviceSession) throws {
        let data = try JSONEncoder().encode(session)
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw Failure.status(status) }
    }

    static func load() -> DeviceSession? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(DeviceSession.self, from: data)
    }

    @discardableResult
    static func clear() -> Bool {
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
