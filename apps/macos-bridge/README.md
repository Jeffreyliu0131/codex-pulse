# CodexPulse macOS Bridge

Swift 5 language mode、macOS 14+ 的只读主机服务。每台会执行 Codex Remote 的 Mac 都需要独立安装一次。

## 数据源与隐私

- `codex app-server` 本地 stdio：每 5 秒读取 `thread/list` 的 thread ID、runtime status、active flags 与时间戳；
- Codex `notify`：仅提取 `agent-turn-complete` 的 thread ID 与 turn ID；输入、回复、cwd 和其他字段立即丢弃；
- 原始 thread ID 只在本机存在，上报前使用 per-host secret 派生 `tsk_`/`evt_` opaque ID；
- Relay secret 存在 Keychain，队列与配置是权限 0600 的本地文件；
- 不监听 HTTP 端口，不连接 App Server WebSocket，不上传 transcript。

## 构建与测试

```sh
swift build --package-path apps/macos-bridge
swift run --package-path apps/macos-bridge codex-pulse-bridge-self-test
./scripts/install-bridge.sh
```

当前开发机已完整编译、链接并通过 25 项 standalone self-test。镜像的 XCTest target 需要完整 Xcode；仅安装 Command Line Tools 时可能没有 `XCTest` 模块。

## 配对与启动

先在 iPhone PWA 的“主机”页生成 8 位码，再在对应 Mac 运行：

```sh
"$HOME/Library/Application Support/CodexPulse/bin/codex-pulse-bridge" \
  pair --relay https://YOUR-VERCEL-DOMAIN --code 12345678 --label "Mac mini"

"$HOME/Library/Application Support/CodexPulse/bin/codex-pulse-bridge" notify-install --yes
"$HOME/Library/Application Support/CodexPulse/bin/codex-pulse-bridge" service-install --yes
"$HOME/Library/Application Support/CodexPulse/bin/codex-pulse-bridge" status
```

`notify-install` 修改用户级 `~/.codex/config.toml`，所以必须显式 `--yes`。它只接受可安全解析且同时符合 TOML 的单行 string array；已有命令会被记录并在每次通知后直接链式执行，不经过 shell。安装前会保存权限 0600 的完整配置备份与哈希，写入后逐字节校验；未触碰其他设置时卸载会精确恢复整个文件，若其他设置后来有合法变化，则只恢复 `notify` 行并保留那些变化。多行、重复、非法转义或歧义配置会原样保留并失败退出。

`service-install` 创建 `~/Library/LaunchAgents/com.codexpulse.bridge.plist`。日志只包含 Bridge 自己的内容安全错误，不记录源 payload。

当前未签名开发版禁止覆盖已配对且二进制哈希不同的安装：`install-bridge.sh` 会失败退出。每次配对还会记录创建 Keychain 项目的精确可执行文件 SHA-256；daemon、notify、安装、测试和重置在调用 Security.framework 前都必须匹配，旧配置缺少指纹时同样拒绝访问并要求重新配对。配对只新增全新 host ID 的 Keychain 项，遇到重复 account 会失败而不会删除覆盖。`LAContext.interactionNotAllowed` 只作为第二层保护，不能替代这道前置门禁。

`notify-uninstall` 已恢复磁盘配置后，正在运行的 Codex 任务仍可能缓存旧 hook。事故恢复时先停止 launchd，并暂时让旧可执行路径不可用；重启任务或 Codex 后再安装最终二进制和重新配对。重复弹窗时不要继续输入密码。

如果 Codex 不在内置候选路径，先为 `service-install` 所在 shell 设置 `CODEX_EXECUTABLE=/absolute/path/to/codex`；安装器会把该专用路径写入 launchd 环境。日志目录权限为 0700，launchd umask 为 077。

## 合成链路测试

```sh
"$HOME/Library/Application Support/CodexPulse/bin/codex-pulse-bridge" test-event
```

它使用固定的本机合成 task identity 和随机 turn identity，不读取真实任务内容。第一次运行验证签名、Relay 与投影；在 PWA 中为该合成任务开启“任务完成”后再次运行，才会验证基于 watch rule 的事件 Push。PWA 设置页的“发送测试”可独立验证 Push 订阅本身。

## 回滚

先在手机端撤销主机，然后运行仓库脚本：

```sh
./scripts/uninstall-bridge.sh
```

脚本卸载 launchd、从校验过的完整备份或记录的原始行恢复先前 notify 配置、删除 Keychain secret，把本地状态和二进制移动到废纸篓。若 notify 配置已被外部修改而无法安全恢复，脚本会停止，不会丢弃回滚记录。
