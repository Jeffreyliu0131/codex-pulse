import Foundation

public enum BridgeBinaryIdentityError: LocalizedError, Equatable {
    case fingerprintMissing
    case fingerprintMismatch
    case executableUnreadable

    public var errorDescription: String? {
        switch self {
        case .fingerprintMissing:
            return "当前配对缺少 Bridge 二进制指纹；为防止钥匙串弹窗，已拒绝访问。请使用最终二进制重新配对"
        case .fingerprintMismatch:
            return "Bridge 二进制已在配对后发生变化；为防止钥匙串弹窗，已拒绝访问。请撤销旧主机并使用当前二进制重新配对"
        case .executableUnreadable:
            return "无法校验 Bridge 二进制；为防止钥匙串弹窗，已拒绝访问"
        }
    }
}

public enum BridgeBinaryIdentity {
    public static func currentExecutableURL() -> URL {
        let value = CommandLine.arguments[0]
        if value.hasPrefix("/") {
            return URL(fileURLWithPath: value).standardizedFileURL
        }
        return URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent(value)
            .standardizedFileURL
    }

    public static func sha256(at executableURL: URL) throws -> String {
        guard let data = try? Data(contentsOf: executableURL, options: .mappedIfSafe) else {
            throw BridgeBinaryIdentityError.executableUnreadable
        }
        return BridgeCrypto.sha256Hex(data)
    }

    public static func currentSHA256() throws -> String {
        try sha256(at: currentExecutableURL())
    }

    public static func requireCredentialAccess(
        config: BridgeConfig,
        actualSHA256: String? = nil
    ) throws {
        guard let expected = config.credentialBinarySHA256?.lowercased(),
              expected.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil
        else {
            throw BridgeBinaryIdentityError.fingerprintMissing
        }
        let actual = try (actualSHA256 ?? currentSHA256()).lowercased()
        guard actual == expected else {
            throw BridgeBinaryIdentityError.fingerprintMismatch
        }
    }
}
