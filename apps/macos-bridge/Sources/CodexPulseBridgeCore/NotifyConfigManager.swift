import Foundation

public enum NotifyConfigError: LocalizedError {
    case consentRequired
    case unsupportedConfiguration
    case bridgeNotPaired
    case notInstalled

    public var errorDescription: String? {
        switch self {
        case .consentRequired: return "需要显式传入 --yes 才能修改用户级 notify 配置"
        case .unsupportedConfiguration: return "Codex 配置无法被安全、无损地更新，已保留原文件并退出"
        case .bridgeNotPaired: return "请先完成 Bridge 配对"
        case .notInstalled: return "CodexPulse notify 尚未安装"
        }
    }
}

public final class NotifyConfigManager {
    private struct ConfigLine {
        var content: String
        var ending: String
    }

    private struct ConfigDocument {
        var lines: [ConfigLine]

        init(_ value: String) {
            var parsed: [ConfigLine] = []
            var start = value.startIndex
            while start < value.endIndex,
                  let newline = value[start...].firstIndex(of: "\n") {
                var content = String(value[start..<newline])
                let ending: String
                if content.hasSuffix("\r") {
                    content.removeLast()
                    ending = "\r\n"
                } else {
                    ending = "\n"
                }
                parsed.append(ConfigLine(content: content, ending: ending))
                start = value.index(after: newline)
            }
            if start < value.endIndex {
                parsed.append(ConfigLine(content: String(value[start...]), ending: ""))
            }
            lines = parsed
        }

        var string: String {
            lines.map { $0.content + $0.ending }.joined()
        }

        var topLevelRange: Range<Int> {
            let firstTable = lines.firstIndex {
                let trimmed = $0.content.trimmingCharacters(in: .whitespaces)
                return !trimmed.hasPrefix("#") && trimmed.hasPrefix("[")
            } ?? lines.count
            return 0..<firstTable
        }

        mutating func replaceTopLevelNotify(at index: Int, with line: String) {
            lines[index].content = line
        }

        mutating func insertTopLevelNotify(_ line: String) {
            let separator = lines.lazy.map(\.ending).first(where: { !$0.isEmpty }) ?? "\n"
            let insertionIndex = topLevelRange.upperBound
            if insertionIndex < lines.count {
                lines.insert(ConfigLine(content: line, ending: separator), at: insertionIndex)
            } else if lines.isEmpty {
                lines.append(ConfigLine(content: line, ending: separator))
            } else if lines[lines.count - 1].ending.isEmpty {
                lines[lines.count - 1].ending = separator
                lines.append(ConfigLine(content: line, ending: ""))
            } else {
                lines.append(ConfigLine(content: line, ending: separator))
            }
        }
    }

    private let codexConfigURL: URL
    private let stateStore: BridgeStateStore
    private let fileManager: FileManager

    private var backupDirectoryURL: URL {
        stateStore.rootURL.appendingPathComponent("notify-config-backups", isDirectory: true)
    }

    public init(
        codexConfigURL: URL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex/config.toml"),
        stateStore: BridgeStateStore = BridgeStateStore(),
        fileManager: FileManager = .default
    ) {
        self.codexConfigURL = codexConfigURL
        self.stateStore = stateStore
        self.fileManager = fileManager
    }

    @discardableResult
    public func install(binaryURL: URL, userConsent: Bool) throws -> Bool {
        guard userConsent else { throw NotifyConfigError.consentRequired }
        let bridgeConfig: BridgeConfig
        do {
            bridgeConfig = try stateStore.loadConfig()
        } catch {
            throw NotifyConfigError.bridgeNotPaired
        }

        let configExisted = fileManager.fileExists(atPath: codexConfigURL.path)
        let existingData = configExisted ? try Data(contentsOf: codexConfigURL) : Data()
        guard let existing = String(data: existingData, encoding: .utf8) else {
            throw NotifyConfigError.unsupportedConfiguration
        }
        var document = ConfigDocument(existing)
        let matches = try Self.topLevelNotifyMatches(in: document)
        let currentCommand = matches.first.flatMap { Self.notifyArray(in: document.lines[$0].content) }
        let desiredCommand = [binaryURL.path, "notify"]

        if currentCommand == desiredCommand {
            guard bridgeConfig.installedNotifyBinary == binaryURL.path,
                  bridgeConfig.notifyConfigBackupFile != nil,
                  bridgeConfig.notifyConfigBackupSHA256 != nil,
                  bridgeConfig.installedNotifyConfigSHA256 != nil,
                  bridgeConfig.notifyConfigPreviouslyExisted != nil,
                  try validatedBackup(for: bridgeConfig) != nil
            else { throw NotifyConfigError.unsupportedConfiguration }
            return false
        }
        guard bridgeConfig.installedNotifyBinary == nil else {
            throw NotifyConfigError.unsupportedConfiguration
        }

        let previousLine = matches.first.map { document.lines[$0].content }
        let newLine = "notify = \(try Self.tomlArray(desiredCommand))"
        guard Self.notifyArray(in: newLine) == desiredCommand,
              !newLine.contains(#"\/"#)
        else { throw NotifyConfigError.unsupportedConfiguration }

        if let index = matches.first {
            document.replaceTopLevelNotify(at: index, with: newLine)
        } else {
            document.insertTopLevelNotify(newLine)
        }
        let updatedData = Data(document.string.utf8)
        let backupURL = try saveBackup(existingData)

        do {
            try stateStore.updateConfig { config in
                config.previousNotifyCommand = currentCommand
                config.previousNotifyLine = previousLine
                config.installedNotifyBinary = binaryURL.path
                config.notifyConfigBackupFile = backupURL.lastPathComponent
                config.notifyConfigBackupSHA256 = BridgeCrypto.sha256Hex(existingData)
                config.installedNotifyConfigSHA256 = BridgeCrypto.sha256Hex(updatedData)
                config.notifyConfigPreviouslyExisted = configExisted
            }
        } catch {
            try? fileManager.removeItem(at: backupURL)
            throw error
        }
        try replaceConfig(
            expectedCurrent: existingData,
            expectedToExist: configExisted,
            with: updatedData
        )
        return true
    }

    @discardableResult
    public func uninstall(userConsent: Bool) throws -> Bool {
        guard userConsent else { throw NotifyConfigError.consentRequired }
        let bridgeConfig = try stateStore.loadConfig()
        guard let installedBinary = bridgeConfig.installedNotifyBinary else {
            throw NotifyConfigError.notInstalled
        }
        guard let backupData = try validatedBackup(for: bridgeConfig),
              let previouslyExisted = bridgeConfig.notifyConfigPreviouslyExisted,
              bridgeConfig.installedNotifyConfigSHA256 != nil
        else { throw NotifyConfigError.unsupportedConfiguration }
        let configExists = fileManager.fileExists(atPath: codexConfigURL.path)
        let existingData = configExists ? try Data(contentsOf: codexConfigURL) : Data()
        guard let existing = String(data: existingData, encoding: .utf8) else {
            throw NotifyConfigError.unsupportedConfiguration
        }
        var document = ConfigDocument(existing)
        let matches = try Self.topLevelNotifyMatches(in: document)
        let currentCommand = matches.first.flatMap { Self.notifyArray(in: document.lines[$0].content) }
        let installedCommand = [installedBinary, "notify"]
        var changed = false

        if currentCommand == installedCommand, let index = matches.first {
            let replacement: Data?
            if bridgeConfig.installedNotifyConfigSHA256 == BridgeCrypto.sha256Hex(existingData) {
                replacement = previouslyExisted ? backupData : nil
            } else {
                if let previousLine = bridgeConfig.previousNotifyLine {
                    guard Self.notifyArray(in: previousLine) == bridgeConfig.previousNotifyCommand else {
                        throw NotifyConfigError.unsupportedConfiguration
                    }
                    document.replaceTopLevelNotify(at: index, with: previousLine)
                } else {
                    document.lines.remove(at: index)
                }
                replacement = Data(document.string.utf8)
            }
            try replaceConfig(
                expectedCurrent: existingData,
                expectedToExist: configExists,
                with: replacement
            )
            changed = true
        } else {
            let originalFileCanStillExist = !previouslyExisted || configExists
            let alreadyRestored = originalFileCanStillExist &&
                currentCommand == bridgeConfig.previousNotifyCommand
            guard alreadyRestored else { throw NotifyConfigError.unsupportedConfiguration }
        }

        let backupName = bridgeConfig.notifyConfigBackupFile
        try stateStore.updateConfig { config in
            config.previousNotifyCommand = nil
            config.previousNotifyLine = nil
            config.installedNotifyBinary = nil
            config.notifyConfigBackupFile = nil
            config.notifyConfigBackupSHA256 = nil
            config.installedNotifyConfigSHA256 = nil
            config.notifyConfigPreviouslyExisted = nil
        }
        if let backupName {
            try? fileManager.removeItem(
                at: backupDirectoryURL.appendingPathComponent(backupName)
            )
        }
        return changed
    }

    public func runPrevious(payload: String) {
        guard let config = try? stateStore.loadConfig(),
              let command = config.previousNotifyCommand,
              let executable = command.first,
              !executable.isEmpty,
              executable != config.installedNotifyBinary
        else { return }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = Array(command.dropFirst()) + [payload]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        let semaphore = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in semaphore.signal() }
        do {
            try process.run()
            if semaphore.wait(timeout: .now() + 15) == .timedOut, process.isRunning {
                process.terminate()
            }
        } catch {
            // Existing notifier failure is isolated and never exposes its payload.
        }
    }

    public static func notifyArray(in line: String) -> [String]? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard !trimmed.hasPrefix("#"),
              let equals = trimmed.firstIndex(of: "="),
              trimmed[..<equals].trimmingCharacters(in: .whitespaces) == "notify"
        else { return nil }
        let rawValue = String(trimmed[trimmed.index(after: equals)...])
        let value = valueBeforeComment(rawValue).trimmingCharacters(in: .whitespaces)
        guard value.hasPrefix("["), value.hasSuffix("]"),
              hasOnlyTOMLCompatibleEscapes(value),
              let data = value.data(using: .utf8),
              let array = try? JSONSerialization.jsonObject(with: data) as? [String],
              !array.isEmpty
        else { return nil }
        return array
    }

    private static func topLevelNotifyMatches(in document: ConfigDocument) throws -> [Int] {
        let candidates = document.topLevelRange.filter {
            isNotifyAssignment(document.lines[$0].content)
        }
        guard candidates.count <= 1,
              candidates.allSatisfy({ notifyArray(in: document.lines[$0].content) != nil })
        else { throw NotifyConfigError.unsupportedConfiguration }
        return candidates
    }

    private static func isNotifyAssignment(_ line: String) -> Bool {
        let value = line.trimmingCharacters(in: .whitespaces)
        return !value.hasPrefix("#") &&
            value.range(of: #"^notify\s*="# , options: .regularExpression) != nil
    }

    private static func valueBeforeComment(_ value: String) -> String {
        var insideString = false
        var escaped = false
        for index in value.indices {
            let character = value[index]
            if escaped {
                escaped = false
            } else if insideString && character == "\\" {
                escaped = true
            } else if character == "\"" {
                insideString.toggle()
            } else if !insideString && character == "#" {
                return String(value[..<index])
            }
        }
        return value
    }

    private static func hasOnlyTOMLCompatibleEscapes(_ value: String) -> Bool {
        let characters = Array(value)
        var insideString = false
        var index = 0
        while index < characters.count {
            let character = characters[index]
            if character == "\"" {
                insideString.toggle()
                index += 1
                continue
            }
            guard insideString && character == "\\" else {
                index += 1
                continue
            }
            guard index + 1 < characters.count else { return false }
            let escape = characters[index + 1]
            if ["\"", "\\", "b", "t", "n", "f", "r"].contains(escape) {
                index += 2
                continue
            }
            if escape == "u" {
                guard index + 5 < characters.count,
                      characters[(index + 2)...(index + 5)].allSatisfy({ $0.isHexDigit })
                else { return false }
                index += 6
                continue
            }
            return false
        }
        return !insideString
    }

    private static func tomlArray(_ values: [String]) throws -> String {
        let data = try JSONSerialization.data(
            withJSONObject: values,
            options: [.withoutEscapingSlashes]
        )
        guard let value = String(data: data, encoding: .utf8),
              !value.contains(#"\/"#),
              notifyArray(in: "notify = \(value)") == values
        else { throw NotifyConfigError.unsupportedConfiguration }
        return value
    }

    private func saveBackup(_ data: Data) throws -> URL {
        try fileManager.createDirectory(
            at: backupDirectoryURL,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try fileManager.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: backupDirectoryURL.path
        )
        let name = "config-\(Int(Date().timeIntervalSince1970))-\(UUID().uuidString).toml"
        let url = backupDirectoryURL.appendingPathComponent(name)
        try writeSecurely(data, to: url)
        return url
    }

    private func validatedBackup(for config: BridgeConfig) throws -> Data? {
        guard let name = config.notifyConfigBackupFile,
              name == URL(fileURLWithPath: name).lastPathComponent,
              let expectedHash = config.notifyConfigBackupSHA256
        else { return nil }
        let url = backupDirectoryURL.appendingPathComponent(name)
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        let data = try Data(contentsOf: url)
        guard BridgeCrypto.sha256Hex(data) == expectedHash else {
            throw NotifyConfigError.unsupportedConfiguration
        }
        return data
    }

    private func writeConfig(_ data: Data) throws {
        try fileManager.createDirectory(
            at: codexConfigURL.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try writeSecurely(data, to: codexConfigURL)
    }

    private func replaceConfig(
        expectedCurrent: Data,
        expectedToExist: Bool,
        with replacement: Data?
    ) throws {
        let existsNow = fileManager.fileExists(atPath: codexConfigURL.path)
        guard existsNow == expectedToExist else {
            throw NotifyConfigError.unsupportedConfiguration
        }
        if existsNow {
            guard try Data(contentsOf: codexConfigURL) == expectedCurrent else {
                throw NotifyConfigError.unsupportedConfiguration
            }
        }
        if let replacement {
            try writeConfig(replacement)
            guard fileManager.fileExists(atPath: codexConfigURL.path),
                  try Data(contentsOf: codexConfigURL) == replacement
            else { throw NotifyConfigError.unsupportedConfiguration }
        } else if existsNow {
            try fileManager.removeItem(at: codexConfigURL)
            guard !fileManager.fileExists(atPath: codexConfigURL.path) else {
                throw NotifyConfigError.unsupportedConfiguration
            }
        }
    }

    private func writeSecurely(_ data: Data, to url: URL) throws {
        try data.write(to: url, options: .atomic)
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        guard try Data(contentsOf: url) == data else {
            throw NotifyConfigError.unsupportedConfiguration
        }
    }
}
