import Foundation
import Security

/// The bridge's secure storage: one Keychain generic-password item per allowlisted key, readable after first unlock,
/// never synced to iCloud or migrated to another device. Values are never logged.
enum SecureStore {
    private static let service = "com.agentempire.mobile.secure"

    enum Failure: Error { case status(OSStatus) }

    private static func query(_ key: BridgeProtocol.Key) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: key.rawValue]
    }

    static func get(_ key: BridgeProtocol.Key) -> String? {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func set(_ key: BridgeProtocol.Key, _ value: String) throws {
        SecItemDelete(query(key) as CFDictionary)
        var add = query(key)
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw Failure.status(status) }
    }

    @discardableResult
    static func delete(_ key: BridgeProtocol.Key) -> Bool {
        let status = SecItemDelete(query(key) as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    /// APP-03 builds kept one JSON item {host, token, deviceId}. Move it to the per-key layout once, as a server session.
    static func migrateLegacySession() {
        let legacy: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                     kSecAttrService as String: "com.agentempire.mobile.device-session",
                                     kSecAttrAccount as String: "current"]
        var q = legacy
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return }
        defer { SecItemDelete(legacy as CFDictionary) }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: String],
              let host = obj["host"], let token = obj["token"], get(.mode) == nil,
              case .success = BridgeProtocol.validate(.serverHost, value: host),
              case .success = BridgeProtocol.validate(.serverToken, value: token) else { return }
        try? set(.serverHost, host)
        try? set(.serverToken, token)
        if let id = obj["deviceId"], case .success = BridgeProtocol.validate(.serverDeviceId, value: id) { try? set(.serverDeviceId, id) }
        try? set(.mode, "server")
    }
}
