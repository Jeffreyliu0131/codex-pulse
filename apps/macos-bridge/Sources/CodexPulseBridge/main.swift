import CodexPulseBridgeCore
import Darwin
import Foundation

@main
struct CodexPulseBridgeCommand {
    static func main() async {
        do {
            try await run()
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? "Bridge 操作失败"
            FileHandle.standardError.write(Data("CodexPulse Bridge: \(message)\n".utf8))
            Darwin.exit(1)
        }
    }

    private static func run() async throws {
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard let command = arguments.first else {
            printHelp()
            return
        }

        switch command {
        case "pair":
            try await pair(arguments)
        case "daemon":
            try await BridgeDaemon().run()
        case "notify":
            await handleNotify(arguments)
        case "notify-install":
            let notifyConfig = try BridgeStateStore().loadConfig()
            try BridgeBinaryIdentity.requireCredentialAccess(config: notifyConfig)
            let changed = try NotifyConfigManager().install(
                binaryURL: BridgeBinaryIdentity.currentExecutableURL(),
                userConsent: arguments.contains("--yes")
            )
            print(changed ? "CodexPulse notify 已安装；原有 notify 将被安全链式调用。" : "CodexPulse notify 已经安装。")
        case "notify-uninstall":
            _ = try NotifyConfigManager().uninstall(userConsent: arguments.contains("--yes"))
            print("CodexPulse notify 已卸载，原有配置已恢复。")
        case "service-install":
            let consent = arguments.contains("--yes")
            if consent {
                let config = try BridgeStateStore().loadConfig()
                try BridgeBinaryIdentity.requireCredentialAccess(config: config)
                _ = try KeychainCredentialStore().load(hostID: config.hostID)
            }
            try ServiceManager().install(
                binaryURL: BridgeBinaryIdentity.currentExecutableURL(),
                userConsent: consent
            )
            print("CodexPulse Bridge 已设为登录后后台运行。")
        case "service-uninstall":
            try ServiceManager().uninstall(userConsent: arguments.contains("--yes"))
            print("CodexPulse Bridge 后台服务已卸载。")
        case "local-reset":
            try localReset(arguments)
        case "status":
            try status()
        case "test-event":
            try await testEvent()
        case "help", "--help", "-h":
            printHelp()
        default:
            printHelp()
            throw CLIError.invalidArguments
        }
    }

    private static func pair(_ arguments: [String]) async throws {
        guard let relayValue = option("--relay", in: arguments),
              let relayURL = URL(string: relayValue),
              let code = option("--code", in: arguments),
              code.range(of: #"^\d{8}$"#, options: .regularExpression) != nil,
              let label = option("--label", in: arguments),
              !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { throw CLIError.invalidArguments }

        let relay = RelayClient()
        let credential = try await relay.pair(
            relayURL: relayURL,
            code: code,
            label: String(label.prefix(64)),
            onStatus: { message in print(message) }
        )
        let stateStore = BridgeStateStore()
        let prior = try? stateStore.loadConfig()
        let credentialBinarySHA256 = try BridgeBinaryIdentity.currentSHA256()
        try KeychainCredentialStore().save(secret: credential.hostSecret, hostID: credential.hostID)
        try stateStore.saveConfig(
            BridgeConfig(
                relayURL: credential.relayURL.absoluteString,
                hostID: credential.hostID,
                hostLabel: credential.hostLabel,
                createdAt: Date(),
                credentialBinarySHA256: credentialBinarySHA256,
                previousNotifyCommand: prior?.previousNotifyCommand,
                previousNotifyLine: prior?.previousNotifyLine,
                installedNotifyBinary: prior?.installedNotifyBinary,
                notifyConfigBackupFile: prior?.notifyConfigBackupFile,
                notifyConfigBackupSHA256: prior?.notifyConfigBackupSHA256,
                installedNotifyConfigSHA256: prior?.installedNotifyConfigSHA256,
                notifyConfigPreviouslyExisted: prior?.notifyConfigPreviouslyExisted
            )
        )
        print("配对完成：\(credential.hostLabel)。主机凭据已保存到 Keychain。")
        print("下一步运行：codex-pulse-bridge notify-install --yes")
        print("然后运行：codex-pulse-bridge service-install --yes")
    }

    private static func handleNotify(_ arguments: [String]) async {
        let payload = arguments.dropFirst().last ?? ""
        let manager = NotifyConfigManager()
        defer { manager.runPrevious(payload: payload) }
        guard let observation = NotifyObservation.parse(json: payload),
              observation.eventType == "agent-turn-complete"
        else { return }

        let store = BridgeStateStore()
        do {
            let config = try store.loadConfig()
            try BridgeBinaryIdentity.requireCredentialAccess(config: config)
            let secret = try KeychainCredentialStore(allowInteraction: false).load(hostID: config.hostID)
            let now = Date()
            _ = try store.enqueueCompletion(
                secret: secret,
                observation: observation,
                observedAt: now
            )
            try store.updateSourceHealth(
                SourceHealth(
                    source: .notify,
                    healthy: true,
                    lastSuccessAt: now,
                    errorCategory: nil
                )
            )
            _ = try? await RelayClient().flush(
                store: store,
                config: config,
                secret: secret,
                maximum: 10
            )
        } catch {
            // Completion remains local when possible; notify must never expose source content.
        }
    }

    private static func status() throws {
        let store = BridgeStateStore()
        let config = try store.loadConfig()
        let runtime = try store.loadRuntime()
        print("CodexPulse Bridge \(bridgeVersion)")
        print("主机：\(config.hostLabel)")
        print("Relay：\(URL(string: config.relayURL)?.host ?? "已配置")")
        print("待发送安全事件：\(try store.queueCount())")
        print("notify：\(config.installedNotifyBinary == nil ? "未安装" : "已安装并保留原配置")")
        let credentialBinding = (try? BridgeBinaryIdentity.requireCredentialAccess(config: config)) == nil
            ? "需重新配对（Keychain 已锁定，不会触发授权弹窗）"
            : "已绑定当前二进制"
        print("凭据保护：\(credentialBinding)")
        for health in runtime.sourceHealth.values.sorted(by: { $0.source.rawValue < $1.source.rawValue }) {
            print("来源 \(health.source.rawValue)：\(health.healthy ? "正常" : "降级")")
        }
    }

    private static func testEvent() async throws {
        let store = BridgeStateStore()
        let config = try store.loadConfig()
        try BridgeBinaryIdentity.requireCredentialAccess(config: config)
        let secret = try KeychainCredentialStore().load(hostID: config.hostID)
        let observation = NotifyObservation(
            eventType: "agent-turn-complete",
            threadID: "codexpulse-bridge-self-test",
            turnID: "synthetic-\(UUID().uuidString)"
        )
        _ = try store.enqueueCompletion(
            secret: secret,
            observation: observation,
            observedAt: Date(),
            source: .synthetic
        )
        let count = try await RelayClient().flush(
            store: store,
            config: config,
            secret: secret
        )
        print("已发送 \(count) 个不含任务内容的合成事件。")
    }

    private static func localReset(_ arguments: [String]) throws {
        guard arguments.contains("--yes") else { throw LocalResetError.consentRequired }
        let store = BridgeStateStore()
        let config = try store.loadConfig()
        try BridgeBinaryIdentity.requireCredentialAccess(config: config)
        guard config.installedNotifyBinary == nil else {
            throw LocalResetError.notifyStillInstalled
        }
        if FileManager.default.fileExists(atPath: store.rootURL.path) {
            let trash = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".Trash", isDirectory: true)
            try FileManager.default.createDirectory(at: trash, withIntermediateDirectories: true)
            let destination = trash
                .appendingPathComponent("CodexPulse-state-\(Int(Date().timeIntervalSince1970))")
            try FileManager.default.moveItem(at: store.rootURL, to: destination)
            print("本地状态已移到废纸篓：\(destination.lastPathComponent)")
        }
        try KeychainCredentialStore().delete(hostID: config.hostID)
        print("主机 Keychain 凭据已删除。请同时在手机端撤销该主机。")
    }

    private static func option(_ name: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: name),
              arguments.indices.contains(index + 1)
        else { return nil }
        return arguments[index + 1]
    }

    private static func printHelp() {
        print("""
        CodexPulse Bridge \(bridgeVersion)

        用法：
          codex-pulse-bridge pair --relay https://… --code 12345678 --label "Mac mini"
          codex-pulse-bridge notify-install --yes
          codex-pulse-bridge service-install --yes
          codex-pulse-bridge daemon
          codex-pulse-bridge status
          codex-pulse-bridge test-event

        回滚：
          codex-pulse-bridge service-uninstall --yes
          codex-pulse-bridge notify-uninstall --yes
          codex-pulse-bridge local-reset --yes
        """)
    }
}

private enum CLIError: LocalizedError {
    case invalidArguments

    var errorDescription: String? {
        "参数不完整，请运行 codex-pulse-bridge help"
    }
}

private enum LocalResetError: LocalizedError {
    case consentRequired
    case notifyStillInstalled

    var errorDescription: String? {
        switch self {
        case .consentRequired:
            return "需要显式传入 --yes 才能删除本机凭据"
        case .notifyStillInstalled:
            return "notify 仍由 CodexPulse 管理；请先运行 notify-uninstall --yes，避免丢失原配置"
        }
    }
}
