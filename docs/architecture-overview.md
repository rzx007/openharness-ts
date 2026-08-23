# OpenHarness 架构总览

> 状态：当前实现的权威鸟瞰。最后核对：2026-08-23。

## 一句话说明

OpenHarness 不是一套 CLI 代码外面再包几个界面。它是一套可以长期保存运行状态的 Agent 应用：CLI、TUI、Web、Desktop、IDE、Bot 和 Workflow 都只是不同入口，共用同一个应用后端和同一套 Agent Runtime。

```text
CLI / TUI / Web / Desktop / IDE / Bot / Workflow
                    |
          HTTP + SSE，或程序内调用
                    |
        Durable Agent Application
   保存 Session、Run、消息、权限和 Workflow
   负责排队、恢复、多客户端、备份和清理
                    |
          Agent Runtime Kernel
   负责一次正在发生的 Agent / Run / Child 执行
                    |
 Provider / Tools / MCP / Memory / Sandbox / Terminal
```

这里的 durable 是“进程退出后记录还在”。Kernel 是“最小执行内核”：它知道怎样运行 Agent，但不知道 HTTP、SQLite 或某个产品界面。

## 三层分别负责什么

### 产品入口

产品入口负责人和机器交互：接收输入、显示消息、处理按钮和平台回调。它不应该自己维护第二套 Run、权限或 Workflow 状态。

- CLI 可以发送一次 prompt，也可以启动和管理 daemon。
- TUI、Web、Desktop、IDE 通过同一个 client 协议读取快照，再持续接收事件。
- Bot 把外部聊天映射到 durable Session；发送失败时重发已保存回复，不重新运行 Agent。
- Workflow 负责有依赖关系的多步计划，但执行仍通过 Application 创建 child Agent 和 Job。

### Durable Agent Application

这一层是长期状态的唯一负责人，主入口是 `DaemonApplication`。它实际做这些事：

1. 在接受请求前取得数据目录的唯一 owner 租约。
2. 把用户输入先写入 SQLite，再创建或找到唯一 Run。
3. 同一个 Session 的 Run 按顺序执行，避免两个模型回合同时改同一份上下文。
4. 从 Agent Runtime 接收有序事件，写入消息、Tool、Attempt、Child 和终态。
5. 把权限请求保存下来，让任意已连接产品处理。
6. 重启时收束失去进程的活动记录，不假装继续旧进程。
7. 提供 snapshot、SSE、检查、清理、备份和恢复。

### Agent Runtime Kernel

这一层只负责正在运行的工作：

- Agent 的 history、usage、当前 Run 和操作互斥；
- 模型回合和 Tool 调用；
- 权限等待；
- child Agent 的创建、继续输入、中断和关闭；
- 全树共享的 child 深度、并发数和总创建数限制；
- 有序事件、运行 Handle 和所有资源的释放。

Kernel 不读取用户配置，不连接数据库，不开 HTTP 服务，也不决定产品如何恢复。默认 Node 入口 `createDefaultNodeAgent()` 会在 Kernel 外面补上 provider、插件、Skill、MCP、Memory、Sandbox 和本机环境。

## 一条 prompt 怎样走完

```text
1. 产品入口提交 prompt 和可选的稳定 inputId
2. Application 在一个事务里保存 Input 和 pending Run
3. Session lane 取得这个 Run
4. AgentPool 取得或创建该 Session 的 live Agent
5. Runtime 发出 input.accepted 和 run.started
6. Application 把事件写成 durable 记录，并推送给客户端
7. 模型和 Tool 循环继续；权限需要时暂停等待 Application
8. Runtime 发出 completed / failed / interrupted
9. Application 先完成消息、Tool、Attempt 等投影，再把 Run 写入终态
10. Run Handle 返回结果，产品入口只展示同一份 durable 结果
```

如果第 8 步已经发生、但第 9 步写数据库失败，系统会保存一条 Projection Settlement。它是一张“还有哪一步没写完”的修复单。重启后先处理修复单，再对外 ready。详细规则见 [Agent Lifecycle Contract](./agent-lifecycle-contract.md) 和 [Projection Settlement ADR](./adr/0001-projection-settlement-failure-policy.md)。

## 状态只允许有一个负责人

| 状态 | 唯一负责人 | 其他层怎样使用 |
|---|---|---|
| live history、当前模型回合、run/child handle | Agent Runtime | Application 通过事件和 Handle 观察、控制 |
| Session、Input、Run、Attempt、消息、权限、Workflow | Durable Application | 产品通过 client/HTTP 读取和修改 |
| 当前选中会话、面板展开状态、输入框草稿 | 产品入口 | 不写成服务端业务真相 |
| provider、文件、进程、Git、MCP、Sandbox | Node 宿主能力 | Runtime 通过明确接口调用 |

最重要的结果是：换一个界面不会换一套运行历史；daemon 重启不会要求产品猜测刚才发生了什么；Runtime 也不需要知道自己被 CLI 还是 Bot 使用。

## 包的边界

| 包 | 当前定位 |
|---|---|
| `@openharness/agent-runtime` | 可独立发布和嵌入的 Agent Runtime；同时提供最小 Kernel 和默认 Node 组装 |
| `@openharness/protocol` | 多端共同使用的数据类型、请求解码和协议能力 |
| `@openharness/services` | SQLite SessionStore、快照、Memory 等持久服务 |
| `@openharness/server` | Durable Application、HTTP、恢复、投影和运维能力 |
| `@openharness/client` | snapshot + SSE 同步、协议检查和共享 reducer |
| `@openharness/coordinator` | Workflow 计划、调度、重试和运行记录 |
| `apps/*` | CLI、TUI、Desktop 等产品入口 |

依赖方向应保持为：

```text
core/protocol -> agent-runtime -> server -> client/apps
```

`agent-runtime` 不能反向依赖 server、HTTP、SSE 或 durable schema。

## 三条一级保证

1. 每条运行记录都有当前版本规定的固定格式。完整表见 [Durable Execution Data Model](./durable-execution-data-model.md)。
2. 所有开始过的运行最终都必须进入明确终态。完整状态机见 [Agent Lifecycle Contract](./agent-lifecycle-contract.md)。
3. child Agent 不能无限扩张。完整预算计算见 [Agent Child Session Flow](./agent-child-session-flow.md#child-预算防止无限叫人)。

## 继续阅读

- 想嵌入 Runtime：[OpenHarness Agent SDK](./agent-sdk.md)
- 想理解 daemon 主链路：[Daemon Application Architecture](./daemon-application-architecture.md)
- 想接一个新产品入口：[Product Surface Integration](./product-surface-integration.md)
- 想理解多端同步：[Client Sync Flow](./client-sync-flow.md)
- 想排障或恢复：[Operations and Recovery](./operations-and-recovery.md)
- 想看认证、权限和 Sandbox 边界：[Security and Trust Boundaries](./security-and-trust-boundaries.md)
