# Context Persistence 服务收口设计

日期：2026-08-31

状态：已确认，作为 `context-persistence-control-plane-design.md` 的实现纠偏

## 结论

daemon 继续拥有 Context 的存储实例、会话授权和作用域解析；`agent-runtime` 继续拥有 Context 工具的注册、调用和逐轮注入。所有可观察的 Context 操作统一由 `ContextPersistenceService` 执行，daemon 与 `ContextResourceService` 不再直接读写 `MarkdownContextStore`。

本次不新增空壳 facade，也不把 Markdown 存储搬进 `agent-runtime`。`ContextQueryService` 继续只负责为 Prompt 挑选、覆盖和渲染相关 Context；它不承担管理型查询或写入。

## 目标边界

```text
Agent Context tools ──┐
HTTP / Desktop ───────┼─→ ContextPersistenceService ─→ MarkdownContextStore
候选管理入口 ─────────┘

每轮 Prompt 注入 ───────→ ContextQueryService ───────→ MarkdownContextStore
```

`ContextPersistenceService` 统一提供：

- `remember`：解析显式记忆请求、检查敏感度与冲突、批量提交。
- `list` / `get`：在给定 runtime scope 内查询受权条目。
- `recall`：为 Agent 工具返回经过公开字段裁剪的逻辑条目。
- `update`：统一敏感信息检查、内容规范化和更新时间。
- `forget`：按逻辑 ID 删除受权条目。
- `resolve`：接受或拒绝候选，验证可选 topic。

所有方法接收已经由宿主解析好的 `ContextRuntimeScope`，不接收 cwd、session store 或物理路径。这样服务能独立测试，同时 daemon 仍是安全边界。

## 入口职责

### daemon

daemon 只做三件事：验证 session 与 cwd 匹配；计算 user/machine/project scope；把 Context service 包装成 `AgentContextMemoryHost`。包装器不得调用 `MarkdownContextStore`、不得重新实现敏感度、topic 或 not-found 规则。

### ContextResourceService

资源服务保留 HTTP/Desktop 需要的 cwd 到 project scope 转换，以及把领域结果转换成 `ContextResourceError`。它的 list/get/update/remove/accept/reject 均委托给 `ContextPersistenceService`，不得直接调用 store。

### agent-runtime

保持现有 Host Capability 契约：有 `contextMemory` 时安装 Context 工具并提示 Agent 使用语义操作；没有宿主能力时不注册工具。它不知道 Markdown 路径，也不拥有长期数据。

## 结果契约

Agent Host 使用不会抛业务异常的结果联合：`committed | completed | forgotten | rejected | clarification | not_found`。HTTP/Desktop 适配器把 `not_found`、secret 和 sensitive 转成既有 `ContextResourceError`，保持客户端契约不变。

更新条目时保留原有 ID、scope、kind、semantic key、topic 与来源，只修改允许的 title/content、normalized content 和 updatedAt。候选接受只能接受 candidate；拒绝候选与忘记 active 都经过同一 locate/forget 实现。

## 测试

先扩充 `context-persistence-service.test.ts`，用真实临时 Markdown store 验证 recall、update、forget、candidate accept/reject、作用域隔离和敏感信息。新测试必须先因方法不存在或旧入口绕过服务而失败。

随后用 route、Context 生命周期和 daemon 相关测试证明三个入口行为不变，并通过类型检查防止适配器残留 store 调用。

## 非目标

- 不改变磁盘 schema、目录或 topic。
- 不改变 Context HTTP API 和 Desktop UI。
- 不改变自动提取与整合策略。
- 不把 Context 存储所有权移动到 `agent-runtime`。
- 不新增数据库或兼容旧 Memory 文件。
