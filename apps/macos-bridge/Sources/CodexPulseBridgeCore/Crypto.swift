import CryptoKit
import Foundation
import Security

public enum BridgeCrypto {
    public static func randomToken(byteCount: Int = 32) -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        let status = SecRandomCopyBytes(kSecRandomDefault, byteCount, &bytes)
        precondition(status == errSecSuccess, "Secure random generation failed")
        return Data(bytes).base64URLEncodedString()
    }

    public static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    public static func hmac(secret: String, value: String) -> String {
        let keyData = Data(base64URLEncoded: secret) ?? Data(secret.utf8)
        let signature = HMAC<SHA256>.authenticationCode(
            for: Data(value.utf8),
            using: SymmetricKey(data: keyData)
        )
        return Data(signature).base64URLEncodedString()
    }

    public static func opaqueTaskKey(secret: String, threadID: String) -> String {
        "tsk_" + hmac(secret: secret, value: "task\n\(threadID)")
    }

    public static func eventID(
        secret: String,
        taskKey: String,
        type: TaskEventType,
        reason: AttentionReason?,
        sourceIdentity: String
    ) -> String {
        let material = [taskKey, type.rawValue, reason?.rawValue ?? "none", sourceIdentity]
            .joined(separator: "\n")
        return "evt_" + hmac(secret: secret, value: material)
    }

    public static func canonicalRequest(
        method: String,
        path: String,
        timestamp: String,
        nonce: String,
        bodyHash: String
    ) -> String {
        [method.uppercased(), path, timestamp, nonce, bodyHash].joined(separator: "\n")
    }
}

public extension Data {
    init?(base64URLEncoded value: String) {
        var normalized = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = normalized.count % 4
        if remainder != 0 { normalized += String(repeating: "=", count: 4 - remainder) }
        self.init(base64Encoded: normalized)
    }

    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
