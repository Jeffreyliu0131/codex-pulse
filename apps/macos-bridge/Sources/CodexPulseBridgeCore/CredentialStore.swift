import Foundation
import LocalAuthentication
import Security

public enum CredentialStoreError: LocalizedError {
    case missing
    case duplicate
    case keychain(OSStatus)

    public var errorDescription: String? {
        switch self {
        case .missing: return "Bridge 主机凭据不存在，请重新配对"
        case .duplicate: return "该主机凭据已存在；为防止覆盖旧 Keychain ACL，已拒绝写入，请撤销旧配对后生成新配对码"
        case .keychain(let status): return "Keychain 操作失败（\(status)）"
        }
    }
}

public protocol HostCredentialStoring: Sendable {
    func save(secret: String, hostID: String) throws
    func load(hostID: String) throws -> String
    func delete(hostID: String) throws
}

public struct KeychainCredentialStore: HostCredentialStoring {
    private let service = "com.codexpulse.bridge.host"
    private let allowInteraction: Bool

    public init(allowInteraction: Bool = true) {
        self.allowInteraction = allowInteraction
    }

    public func save(secret: String, hostID: String) throws {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: hostID
        ]
        var attributes = base
        attributes[kSecValueData as String] = Data(secret.utf8)
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status == errSecDuplicateItem { throw CredentialStoreError.duplicate }
        guard status == errSecSuccess else { throw CredentialStoreError.keychain(status) }
    }

    public func load(hostID: String) throws -> String {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: hostID,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        if !allowInteraction {
            let context = LAContext()
            context.interactionNotAllowed = true
            query[kSecUseAuthenticationContext as String] = context
        }
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { throw CredentialStoreError.missing }
        guard status == errSecSuccess,
              let data = result as? Data,
              let secret = String(data: data, encoding: .utf8)
        else { throw CredentialStoreError.keychain(status) }
        return secret
    }

    public func delete(hostID: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: hostID
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw CredentialStoreError.keychain(status)
        }
    }
}
