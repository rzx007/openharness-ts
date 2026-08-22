# ADR 0001：Projection Settlement 失败分类与恢复边界

## 状态

已接受，2026-08-22。

## 背景

`DaemonAgentEventProjector` 会把 Framework 的 `AgentEvent` 转换成 Session、Run、Task 和可回放事件。旧实现只在 Projector 对象内保存 `pendingSettlement`。如果修复尚未成功时 Daemon 退出，新进程既看不到这项待办，也拿不到旧 child handle、Promise 或 execution bridge。

## 决策

使用 SQLite `projection_settlement` 表保存可跨进程恢复的窄任务。记录只包含 Projector 身份、根 Session、Framework 事件序号、修复动作、可序列化事件、错误文字、状态和尝试次数。它不保存 live handle，也不承诺恢复旧进程本身。

失败分为三类：

1. **可重试的 durable terminal projection**：典型情况是 `child.closed` 已发生，但 Task 终态或 `agent.child.closed` 事件未写完。恢复器根据事件中的 `childId` 和 result 直接补齐 durable Task，并用 Framework event ID 去重追加事件。
2. **只能做 durable compensation**：child 创建、路由注册、Run/Task 绑定等步骤失败后，旧 live 对象不可恢复。恢复器把仍活跃的 Run/Task 标为 failed，并在需要时归档半初始化 child Session；不会重新执行模型或工具。
3. **存储完全不可用**：如果连 Settlement 都无法写入，Projector 返回包含原投影错误和持久化错误的 `AggregateError`。系统不能把这种情况记录成成功，也不能声称 exactly-once。

## 执行时机

- 原事件失败后立即创建或复用 Settlement，并做一次有限修复尝试。
- 同一 Projector 应用下一事件前，先修复同一根 Session 的 pending Settlement；未解决时不越过该事件。
- Daemon 构造应用图时、对外 ready 前做一次全局恢复，然后才执行普通的 active Run/Task 重启收束。
- 显式调用 `recoverProjectionSettlements()` 可以再做一次有限修复；没有后台无限重试循环。

唯一键是 `projector + root_session_id + event_sequence`。Projector ID 包含 Agent 实例 ID，因此 Daemon 重启后新 Agent 从较小事件序号重新开始时不会与旧实例冲突。

## 幂等规则

- 重复创建同一唯一键且 action/payload 相同，返回原记录；内容不同则报 identity conflict。
- Task 已是目标终态时不重复更新。
- `agent.child.closed` 使用 Framework event ID 去重。
- Run compensation 只修改 pending/running Run，并使用 Framework event ID 去重错误事件。
- resolved/abandoned 记录不再进入自动恢复。

## 结果与限制

重启后能够补齐 durable 状态，`/debug/runtime` 也能看到 pending 数量。SQLite 完全不可用时仍只能依靠错误传播和下次启动的活动实体扫描，因此本设计提供的是可恢复收束，不是 exactly-once 事务消息系统。
