# CodexPulse PRD

状态：Personal MVP and cloud baseline implemented; host/iPhone validation pending
日期：2026-08-11  
负责人：Jeff  
阶段：云端基线完成，等待主机与真实设备验收

## 1. Executive Summary

我们要为使用 ChatGPT Remote 管理一台或多台 Mac 上 Codex 任务的个人用户，构建一个通知优先的只读 PWA。Mac 上的轻量 Bridge 采集 Codex 任务状态，经认证的 Relay 生成 Web Push；用户在手机锁屏收到完成、失败、等待批准或等待输入提醒，并可进入对应任务详情。第一版的价值是减少手动检查与任务阻塞，不替代 ChatGPT Remote，也不在手机端执行高风险操作。

## 2. Problem Statement

### 谁遇到问题

频繁使用 ChatGPT Remote、同时运行多个 Codex 任务、并会离开电脑等待结果的个人开发者。

### 问题是什么

ChatGPT 手机 App 对普通 Chat 的通知较明显，但 Remote 内的任务完成和等待处理提醒较少或不稳定。用户无法确信手机会在真正需要处理时提醒，因此只能反复打开 Remote 检查。

### 为什么痛苦

- 完成的任务长时间无人复查，延长交付周期；
- 等待批准或输入的任务无效阻塞；
- 多台主机和多个项目难以判断是哪一个任务需要处理；
- 手动轮询打断其他工作；
- 锁屏通知若包含完整提示词、回复或路径，又会造成隐私风险。

### 证据

- 用户直接报告 Remote 提醒不足。
- 既有主机侧原型已验证本机和远端状态可以被归一化聚合。
- 当前远端实现依赖 ChatGPT Desktop 缓存，并非稳定的公开远端订阅接口。
- OpenAI 官方文档说明 Remote 支持手机端跟踪、批准和复查，也说明通知渠道会因界面和账号而异。

## 3. Target Users and Personas

### Primary Persona：多主机 Codex 高级用户

- 设备：iPhone、MacBook、Mac mini；
- 行为：并行运行多个长任务，通过 ChatGPT Remote 查看；
- 目标：离开电脑后仍能在需要决策时快速回来；
- 痛点：通知漏掉、状态来源不透明、多个任务难以区分；
- 技术水平：能安装 Mac 辅助程序和 PWA，但不希望维护复杂服务器。

### Secondary Persona：单主机长任务用户

- 只连接一台 Mac；
- 主要需要完成和失败提醒；
- 对完整对话与远程批准需求较低。

### Job to Be Done

当 Codex 在后台执行工作时，我希望只在任务完成、失败或真正需要我处理时收到清晰提醒，这样我不必持续检查 Remote。

## 4. Strategic Context

### Why now

- 既有主机侧原型已完成关键状态识别，复用成本较低；
- Remote 已成为真实工作入口，通知缺口直接影响工作闭环；
- iPhone 主屏幕 Web App 已支持系统级 Web Push；
- 先做只读提醒可以在不承担远程执行风险的情况下验证价值。

### 产品机会

第一阶段是个人自用工具。只有提醒可靠性和实际使用频率得到验证后，才评估是否扩展为可分发产品。

## 5. Solution Overview

### 高层方案

CodexPulse 包含三个运行组件：

1. macOS Bridge：通过本地 App Server 状态与官方 notify 生成标准事件；
2. Relay：在 Vercel Function 中验证主机身份，通过 Neon 保存状态、去重并发送 Web Push；
3. PWA：安装到手机主屏幕，订阅通知并展示两台主机的被关注任务。

### 核心用户流程

#### 首次设置

1. 用户打开 PWA；
2. PWA 提示添加到主屏幕；
3. 用户在明确按钮点击后授权通知；
4. PWA 生成一次性配对码；
5. 用户在 Mac Bridge 输入或扫描配对码；
6. PWA 显示已连接主机及最后在线时间。

#### 关注对话

1. PWA 显示已发现的 opaque Codex 任务及来源；
2. 用户通过主机、状态和自己设置的安全别名识别任务；
3. 用户对某个任务开启重点关注；
4. Relay 保存关注规则；
5. 只有匹配事件才触发提醒。

#### 收到提醒

1. Bridge 捕捉状态变化；
2. Relay 校验、去重并判断是否符合关注规则；
3. 手机收到锁屏通知；
4. 点击通知打开 PWA 内对应任务详情；
5. 用户决定是否切换到 ChatGPT Remote 继续处理。

### 主要页面

- Setup：安装、通知授权、设备配对；
- Activity：运行中、需要处理、失败、近期完成；
- Task Detail：主机、安全别名、状态、更新时间、数据来源；
- Watch Rules：任务详情内的事件类型、静音与别名设置；
- Settings：隐私、通知测试、设备撤销、数据保留。

## 6. Success Metrics

以下目标为 MVP 的工程验收目标，需在 Spike 后校准。

### Primary Metric

被支持且符合关注规则的任务事件，成功产生手机通知的比例达到 95% 以上。

### Secondary Metrics

- 完成事件端到端通知延迟中位数不超过 10 秒；
- 等待批准或输入事件端到端通知延迟中位数不超过 15 秒；
- 重复通知率低于 1%；
- 点击通知后打开正确 CodexPulse 任务详情的比例达到 99%；
- Bridge 断线恢复后，未过期重要事件可补发；
- 用户日常不再需要为了确认任务状态而频繁打开 Remote。

### Guardrails

- 推送内容不包含完整提示词、回复、命令、diff 或绝对路径；
- Relay 不保存 ChatGPT 登录凭据；
- PWA 第一版不能批准命令或发送提示词；
- Bridge 不对公网开放 App Server 或本机端口；
- 对 Codex 内部格式变化有明确降级和健康提示。

## 7. User Stories and Requirements

### Epic Hypothesis

我们相信，为多主机 Codex 用户提供可筛选、低噪声的手机系统提醒，可以显著减少手动轮询和等待处理时间。我们将通过事件送达率、端到端延迟、重复率和实际手动检查次数验证这一点。

### P0 Story 1：安装并授权 PWA 通知

作为用户，我希望将 CodexPulse 添加到 iPhone 主屏幕并开启通知，以便在应用未打开时收到提醒。

Acceptance Criteria:

- PWA 提供清晰的添加到主屏幕说明；
- 只有在用户主动点击开启通知后请求权限；
- 权限拒绝、关闭或不支持时有明确状态；
- 可发送一条测试通知；
- PWA 只有在浏览器 PushSubscription 与 Relay 上未停用的 registration ID 一致时才显示订阅有效；
- 测试结果区分 Relay 无订阅、Push 服务临时失败、订阅失效与 Push 服务接受。

### P0 Story 2：安全配对 Mac 主机

作为用户，我希望安全地连接自己的 Mac，而不暴露 ChatGPT 凭据。

Acceptance Criteria:

- 配对码一次性、短时有效；
- 每台主机获得独立凭据；
- 用户能在 PWA 撤销单台主机；
- Relay 拒绝过期、重复或签名错误的事件；
- Bridge 只建立出站连接。

### P0 Story 3：查看任务状态

作为用户，我希望看到不同主机上的 Codex 任务，以便知道哪里正在工作或等待我。

Acceptance Criteria:

- 展示设备、安全别名或 opaque 任务标签、状态和更新时间；
- 状态至少包含运行、需要处理、失败和近期完成；
- 标记数据来源及新鲜度；
- 支持按状态筛选，并在每个任务上明确显示设备；项目筛选因最小化数据原则延后；
- 数据过期时不能继续显示成实时。

### P0 Story 4：关注具体对话

作为用户，我希望只关注重要对话，以减少无关通知。

Acceptance Criteria:

- Bridge 本地关注身份至少包含 host ID 和 conversation ID；Relay/PWA 只使用派生的 opaque task ID；
- 可选择完成、失败、等待批准和等待输入事件；
- 可关闭或删除关注规则；
- 同一个事件不会因多个规则重复提醒；
- 未关注的任务仍可在 Activity 中查看，但默认不推送。

### P0 Story 5：收到完成与失败提醒

作为用户，我希望任务完成或失败时收到手机通知，以便及时复查。

Acceptance Criteria:

- 完成事件优先使用主机侧可靠事件源；
- 每个事件有稳定去重 ID；
- 通知只显示安全摘要；
- 点击通知打开正确的 PWA 任务详情；
- 通知使用 opaque event ID 做点击归因，并记录该事件的 Push 尝试、服务接受与“从通知打开”时间；普通任务卡查看只标记已读，不冒充通知点击；
- 设备离线后恢复时，只补发仍有价值且未过期的事件。

### P0 Story 6：收到等待处理提醒

作为用户，我希望任务等待批准或输入时收到提醒，以便解除阻塞。

Acceptance Criteria:

- waitingOnApproval 和 waitingOnUserInput 被区分记录；
- PWA 可用不同文案呈现两种状态；
- 状态恢复后不会继续显示为需要处理；
- 如果数据源只是缓存轮询，界面明确显示来源与更新时间；
- 不在通知内展示完整命令或用户问题。

### P1 Story 7：查看近期活动

作为用户，我希望查看最近事件，以便确认是否漏看通知。

Acceptance Criteria:

- 展示最近完成、失败和需要处理事件；
- 支持标记已查看；
- 提供默认保留期和手动清理；
- 多设备查看状态保持一致。
- 近期事件显示是否触发 Push、Push 服务是否接受，以及是否从通知进入 CodexPulse；不把普通任务卡查看或服务接受误称为锁屏已送达。

### P1 Story 8：打开 ChatGPT Remote

作为用户，我希望从详情页进入 ChatGPT Remote 继续处理。

Acceptance Criteria:

- 只有在验证可用的公开 URL 或深链后才显示精确打开按钮；
- 无精确深链时提供打开 Remote 首页的安全回退；
- 不通过模拟点击或移动端私有 URL 冒充稳定能力。

### Constraints and Edge Cases

- iPhone Web Push 需要主屏幕 Web App、用户手势授权和 HTTPS；
- Focus 或系统通知设置可能影响展示；
- 推送延迟通常高于已建立的 WebSocket；
- Remote 缓存可能只保留有限数量的任务摘要；
- notLoaded 表示没有实时运行状态，不能被误报为刚完成；
- Bridge、Relay 或手机可能分别离线；
- 同一 conversation ID 在不同 host 上必须隔离；
- 现有用户 notify 配置必须保留；
- ChatGPT Desktop 或 Codex 更新可能改变内部缓存与 IPC。

## 8. Out of Scope

第一版不包含：

- PWA 内发送 Prompt；
- PWA 内批准命令、网络或文件修改；
- 完整终端；
- 默认同步完整聊天记录；
- ChatGPT 普通聊天同步；
- 多用户团队权限；
- App Store 原生 iOS 客户端；
- 依赖 ChatGPT Web Cookie 或未公开个人会话 API；
- 承诺直接打开任意 ChatGPT Remote 精确对话。

## 9. Dependencies and Risks

### Dependencies

- 每台执行任务的 Mac 可运行 Bridge；
- 一个 HTTPS Relay；
- Web Push 密钥和有效订阅；
- Codex 可用状态源；
- ChatGPT Desktop 或 Codex 主机保持在线。

### Risks and Mitigations

#### 风险：Remote 缓存延迟或漏报

Mitigation：完成事件优先使用 notify；关键状态尽量由执行主机直接采集；缓存仅作为降级源。

#### 风险：内部格式变化

Mitigation：所有内部来源放在独立 Adapter；版本探测；fixture 测试；健康状态提示。

#### 风险：通知泄露内容

Mitigation：默认发送通用文案与 opaque ID；打开 PWA 后认证拉取详情。

#### 风险：重复或乱序

Mitigation：使用 event ID、source sequence、observedAt 和 expiresAt；Relay 幂等写入。

#### 风险：PWA 通知被 Focus 抑制

Mitigation：提供通知测试、安装检查和健康诊断；产品文案不承诺绝对实时。

#### 风险：远程批准带来安全事故

Mitigation：MVP 完全只读；后续需要单独威胁建模与签名挑战。

## 10. Remaining Validation Questions

产品与技术选择已由 D-011 至 D-018 决定。云端基线已确认使用 Vercel；上线验收仍需用真实设备回答：

1. MacBook 与 Mac mini 上的真实 Remote turn 是否都稳定触发用户级 notify；目标为至少 9/10。
2. 独立 App Server 的 `thread/list` 在两台目标主机上能否稳定观测 Remote 的 `waitingOnApproval` 与 `waitingOnUserInput`。
3. iPhone 主屏幕 PWA 在锁屏、后台、离线恢复与 Focus 场景中的送达率和延迟。
4. 是否存在可公开依赖的 ChatGPT Remote 精确移动端深链；在验证前只打开 CodexPulse 详情。
5. 真实使用后是否值得把项目标签作为用户明确选择的可同步字段加入 v2。
