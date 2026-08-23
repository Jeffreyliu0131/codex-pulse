import Darwin
import Foundation

public enum ServiceManagerError: LocalizedError {
    case consentRequired
    case launchctlFailed

    public var errorDescription: String? {
        switch self {
        case .consentRequired: return "需要显式传入 --yes 才能修改登录启动项"
        case .launchctlFailed: return "launchd 服务安装失败"
        }
    }
}

public final class ServiceManager {
    private let fileManager: FileManager
    private let homeURL: URL
    public let label = "com.codexpulse.bridge"

    public init(
        homeURL: URL = FileManager.default.homeDirectoryForCurrentUser,
        fileManager: FileManager = .default
    ) {
        self.homeURL = homeURL
        self.fileManager = fileManager
    }

    public var plistURL: URL {
        homeURL.appendingPathComponent("Library/LaunchAgents/\(label).plist")
    }

    public func install(binaryURL: URL, userConsent: Bool) throws {
        guard userConsent else { throw ServiceManagerError.consentRequired }
        let logs = homeURL.appendingPathComponent("Library/Logs/CodexPulse", isDirectory: true)
        try fileManager.createDirectory(
            at: logs,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: logs.path)
        try fileManager.createDirectory(
            at: plistURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let configuredCodex = ProcessInfo.processInfo.environment["CODEX_EXECUTABLE"]
            .flatMap { $0.isEmpty ? nil : $0 }
        let environment = configuredCodex.map {
            """
              <key>EnvironmentVariables</key><dict>
                <key>CODEX_EXECUTABLE</key><string>\(Self.xml($0))</string>
              </dict>
            """
        } ?? ""
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0"><dict>
          <key>Label</key><string>\(label)</string>
          <key>ProgramArguments</key><array>
            <string>\(Self.xml(binaryURL.path))</string><string>daemon</string>
          </array>
          <key>RunAtLoad</key><true/>
          <key>KeepAlive</key><true/>
          <key>ProcessType</key><string>Background</string>
          <key>Umask</key><integer>63</integer>
          <key>StandardOutPath</key><string>\(Self.xml(logs.appendingPathComponent("bridge.log").path))</string>
          <key>StandardErrorPath</key><string>\(Self.xml(logs.appendingPathComponent("bridge-error.log").path))</string>
          <key>ThrottleInterval</key><integer>10</integer>
        \(environment)
        </dict></plist>
        """
        try Data(plist.utf8).write(to: plistURL, options: .atomic)
        try fileManager.setAttributes([.posixPermissions: 0o644], ofItemAtPath: plistURL.path)
        _ = runLaunchctl(["bootout", "gui/\(getuid())", plistURL.path], tolerateFailure: true)
        guard runLaunchctl(["bootstrap", "gui/\(getuid())", plistURL.path], tolerateFailure: false) else {
            throw ServiceManagerError.launchctlFailed
        }
    }

    public func uninstall(userConsent: Bool) throws {
        guard userConsent else { throw ServiceManagerError.consentRequired }
        _ = runLaunchctl(["bootout", "gui/\(getuid())", plistURL.path], tolerateFailure: true)
        if fileManager.fileExists(atPath: plistURL.path) {
            try fileManager.removeItem(at: plistURL)
        }
    }

    private func runLaunchctl(_ arguments: [String], tolerateFailure: Bool) -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0 || tolerateFailure
        } catch {
            return tolerateFailure
        }
    }

    private static func xml(_ value: String) -> String {
        value.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }
}
