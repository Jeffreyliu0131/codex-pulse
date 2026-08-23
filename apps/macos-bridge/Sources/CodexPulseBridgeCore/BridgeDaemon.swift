import Foundation

public final class BridgeDaemon {
    private let stateStore: BridgeStateStore
    private let credentials: HostCredentialStoring
    private let relay: RelayClient
    private let appServer: AppServerClient

    public init(
        stateStore: BridgeStateStore = BridgeStateStore(),
        credentials: HostCredentialStoring = KeychainCredentialStore(allowInteraction: false),
        relay: RelayClient = RelayClient(),
        appServer: AppServerClient = AppServerClient()
    ) {
        self.stateStore = stateStore
        self.credentials = credentials
        self.relay = relay
        self.appServer = appServer
    }

    public func run() async throws {
        let config = try stateStore.loadConfig()
        try BridgeBinaryIdentity.requireCredentialAccess(config: config)
        let secret = try credentials.load(hostID: config.hostID)
        var retrySeconds = 2.0

        while !Task.isCancelled {
            let now = Date()
            let sourceWasUnhealthy = (try? stateStore.loadRuntime())?
                .sourceHealth[EventSource.appServer.rawValue]?
                .healthy == false
            do {
                let threads = try appServer.listThreads(limit: 100)
                for thread in threads {
                    _ = try stateStore.enqueueObservation(
                        secret: secret,
                        observation: thread,
                        observedAt: now
                    )
                }
                try stateStore.updateSourceHealth(
                    SourceHealth(
                        source: .appServer,
                        healthy: true,
                        lastSuccessAt: now,
                        errorCategory: nil
                    )
                )
            } catch {
                appServer.stop()
                let lastSuccess = (try? stateStore.loadRuntime())?
                    .sourceHealth[EventSource.appServer.rawValue]?
                    .lastSuccessAt
                try? stateStore.updateSourceHealth(
                    SourceHealth(
                        source: .appServer,
                        healthy: false,
                        lastSuccessAt: lastSuccess,
                        errorCategory: Self.errorCategory(error)
                    )
                )
                try? await sendHeartbeatIfNeeded(
                    config: config,
                    secret: secret,
                    now: now,
                    force: true,
                    syncSnapshots: false
                )
                try await Task.sleep(for: .seconds(retrySeconds))
                retrySeconds = min(retrySeconds * 2, 60)
                continue
            }

            do {
                _ = try await relay.flush(store: stateStore, config: config, secret: secret)
                try await sendHeartbeatIfNeeded(
                    config: config,
                    secret: secret,
                    now: now,
                    force: sourceWasUnhealthy,
                    forceSnapshot: sourceWasUnhealthy,
                    syncSnapshots: true
                )
                retrySeconds = 2
                try await Task.sleep(for: .seconds(5))
            } catch {
                // Keep the healthy App Server process and local queue intact when
                // only Relay/network delivery fails. Host freshness will expose
                // the connection loss without mislabeling the source as broken.
                try? await sendHeartbeatIfNeeded(
                    config: config,
                    secret: secret,
                    now: now,
                    force: true,
                    syncSnapshots: true
                )
                try await Task.sleep(for: .seconds(retrySeconds))
                retrySeconds = min(retrySeconds * 2, 60)
            }
        }
        appServer.stop()
    }

    private func sendHeartbeatIfNeeded(
        config: BridgeConfig,
        secret: String,
        now: Date,
        force: Bool = false,
        forceSnapshot: Bool = false,
        syncSnapshots: Bool
    ) async throws {
        let runtime = try stateStore.loadRuntime()
        let intervalElapsed = runtime.lastHeartbeatAt.map { now.timeIntervalSince($0) >= 5 * 60 } ?? true
        if !force && !intervalElapsed {
            return
        }
        if syncSnapshots && (intervalElapsed || forceSnapshot) {
            let batch = try stateStore.makeSnapshotBatch(secret: secret, now: now)
            if !batch.snapshots.isEmpty {
                _ = try await relay.syncSnapshots(batch, config: config, secret: secret)
            }
        }
        let heartbeat = HostHeartbeat(
            observedAt: now,
            sources: runtime.sourceHealth.values.sorted { $0.source.rawValue < $1.source.rawValue },
            queuedEventCount: try stateStore.queueCount(now: now)
        )
        try await relay.heartbeat(heartbeat, config: config, secret: secret)
        try stateStore.markHeartbeat(now)
    }

    private static func errorCategory(_ error: Error) -> String {
        switch error {
        case AppServerClientError.executableNotFound: return "codex_not_found"
        case AppServerClientError.timeout: return "app_server_timeout"
        case AppServerClientError.disconnected: return "app_server_disconnected"
        case RelayClientError.requestFailed(_, _): return "relay_rejected"
        default: return "temporary_failure"
        }
    }
}
