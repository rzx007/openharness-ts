# Context、Prompt 与会话连续性总图

> 状态：当前实现。长期上下文统一由 `ContextPersistenceService` 管理；旧 `USER.md`、local rules、Project Memory 和 `/memory` 不再读取，也不再兼容。

OpenHarness 中“让 Agent 以后还知道一件事”分成三类能力。它们的生命周期不同，不能混在一起：

| 能力 | 实际解决什么 | 谁能修改 | 何时进入模型 |
|---|---|---|---|
| Agent 身份 | Agent 是谁、保持什么人格与基本工作方式 | 身份配置服务 | 构建稳定 system prompt 时 |
| 长期 Context | 用户偏好、本机环境事实、项目规则与项目知识 | `ContextPersistenceService` 及其语义工具/API | 每次真实模型请求前重新查询 |
| Session Continuity | 当前会话目标、下一步、最近进展 | Run 成功后的 checkpoint 维护 | 仅在 compact/autocompact 时 |
| Durable Transcript | 消息、Run、Tool、Permission 等可恢复事实 | Durable Application | 恢复会话、重放与审计时 |

长期 Context 和 Session Continuity 都使用 Markdown，但 Agent 不接触文件位置。Agent 只表达“记住、回忆、修改、确认、忘记”，服务负责选择作用域、主题、条目 ID、校验规则和写盘方式。

## 运行所有权

```text
Agent Context tools ──┐
HTTP / Desktop ───────┼─→ ContextPersistenceService ─→ MarkdownContextStore
候选管理入口 ─────────┘              ↑
                                     │ daemon 持有实例并解析 scope

每轮模型请求 ─────────────→ ContextQueryService ───────→ MarkdownContextStore
```

这里的分工是“runtime 拥有使用能力，daemon 拥有持久资源”：`agent-runtime` 安装语义工具并消费 Host Capability；daemon 验证 session/cwd，计算 user/machine/project scope，再把调用交给统一服务。daemon 的 Host adapter 和 HTTP/Desktop 的 Resource adapter 都不能直接读写 Store。

Prompt 查询单独走 `ContextQueryService`，因为它解决的是相关性、覆盖和字符预算，不是管理操作；所有管理型读取和写入则统一经过 `ContextPersistenceService`。

## 长期 Context 的逻辑模型

### 三种作用域

- `user`：跨项目生效的个人偏好，例如回答详细程度、注释语言和 UI 设计偏好。
- `machine`：只对当前机器成立的环境事实，例如本机工具位置或开发环境名称。
- `project`：只对当前项目成立的规则、决策和知识，例如包管理器、提交要求和架构约定。

作用域由系统结合用户措辞和当前 Session 自动判断。明确说“全局”“这个项目”“当前机器”，并且判断置信度足够高时立即保存；作用域不明确时返回澄清结果，不猜。

### 主题文档与独立条目

存储服务按主题组织 Markdown，而不是“一条规则一个文件”。常用主题包括：

- 用户偏好
- UI 设计偏好
- 开发工作流
- 项目规则
- 项目知识
- 环境事实
- 待确认候选

一个主题文档可以包含多个独立的 entry block。每个 block 都有稳定 ID、语义键、作用域、状态、来源、置信度和更新时间，因此可以单独更新、接受、拒绝或忘记。比如一整组 UI 规范会进入同一个 UI 主题文档，但“配色”“圆角”“阴影”仍是可独立管理的条目。

这些 Markdown 文档属于受管状态。普通 Read/Write/Edit 文件工具不能绕过服务直接修改它们，管理界面和 API 也不会向 Agent 或用户暴露存储路径。

## 写入判断

```text
用户明确要求记住
  └─ 拆成一个或多个语义条目
       ├─ 检测到 secret → 拒绝该条，其他安全条目继续处理
       ├─ 涉及敏感信息 → 询问确认
       ├─ 作用域不明确 → 询问作用域
       ├─ 与已有条目冲突 → 询问；若用户明确说“改成/替换为”则更新
       ├─ 高置信度且无冲突 → 立即保存
       └─ 低置信度 → 询问
```

明确要求且判断可靠时不会额外显示撤销胶囊。系统遵循“拿不准再问”，但不会把所有记忆都变成人工审批。

自动提取走同一套政策：只有高置信度、非敏感的环境事实可以自动提交；其他有价值内容进入候选；secret 直接丢弃。自动提取失败不会改变已经完成的 Run 状态。

## 读取与热更新

`ContextQueryService` 在每次物理模型请求前读取当前 `user`、`machine` 和 `project` 作用域，按语义键合并，并在字符数和条目数预算内生成瞬态 Context 段：

- 项目条目可以覆盖相同语义键的用户默认偏好。
- 项目知识只在和当前输入相关时进入 prompt。
- 候选、已禁用、已取代和已删除条目不会注入。
- 注入内容不写进消息历史，也不修改常驻 system prompt。
- 修改后无需销毁热 Agent；下一次模型请求会读到最新结果。

## 管理入口

Agent 使用语义能力：

- `ContextRemember`
- `ContextRecall`
- `ContextResolve`
- `ContextUpdate`
- `ContextForget`

客户端使用资源 API：

- `GET /context/entries`
- `POST /context/entries`
- `GET/PATCH/DELETE /context/entries/:id`
- `GET /context/candidates`
- `POST /context/candidates/:id/accept`
- `POST /context/candidates/:id/reject`
- `GET /context/status`
- `POST /context/preview`

Slash 命令使用相同服务：

- `/remember <内容>`：显式记住，不再扫描整段会话。
- `/context list|show|add|update|remove`
- `/context candidates|accept|reject`
- `/context status|preview`
- `/dream [--preview]`：受控整合逻辑条目，不允许模型指定文件或目录。

Desktop 的 Context 管理页提供 active/candidate 列表、筛选、预览、新增、编辑、删除确认，以及候选接受/拒绝。界面只显示逻辑作用域、主题和条目 ID。

## Session Continuity

Session Continuity 是 compact 专用 checkpoint，不属于长期 Context：

1. root Run 成功后，从 durable transcript 写入当前会话 checkpoint。
2. `/compact` 或 autocompact 开始时，attachments provider 读取 checkpoint。
3. checkpoint 作为 `Session Memory Checkpoint` 附件加入摘要 prompt。
4. 它不会进入每轮普通 system prompt，也不能通过 Context 管理页修改。

配置开关是 `sessionContinuity.enabled`。长期 Context 的开关和预算位于 `context` 配置组，两者互不代替。

## 不再生效的旧入口

以下旧结构即使仍留在用户机器上也不会被运行时读取：

- `USER.md`
- local rules 的 `facts.json` / `rules.md`
- 旧 Project Memory / `MEMORY.md`
- `/memory`
- `/profile`
- 旧 Session 全量 `/remember` 提取接口

仓库不会自动删除这些用户文件。用户可以自行归档或清理；它们不再影响 Agent 行为。

## 排查顺序

1. `/context status`：确认功能是否开启、active 和 candidate 数量。
2. `/context list`：查看当前逻辑作用域的条目。
3. `/context candidates`：确认内容是否在等待人工决定。
4. `/context preview <问题>`：查看下一轮会注入什么。
5. `/config show`：检查 `context` 与 `sessionContinuity`。
6. compact 问题再检查 Run 是否成功完成，以及 continuity checkpoint 维护告警。

## 安全边界

- API key、token、密码、私钥和凭据永远不能写入 Context。
- 内部 IP、私有 endpoint 等敏感事实需要确认，自动提取只能生成候选。
- 冲突不会静默覆盖；只有明确替换语言才能直接更新。
- consolidation planner 只看到逻辑条目，输出中出现 path、directory、root 或 file 会被拒绝。
- 每次执行整合前都会备份受影响的主题文档，preview 不写盘。

相关文档：

- [Context Persistence 生命周期](./memory-system.md)
- [Prompt 分层](./prompt-layering-design.md)
- [Compact Service](./compact-service-design.md)
- [安全与信任边界](./security-and-trust-boundaries.md)
