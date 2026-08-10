# Daemon Session Runtime Design (Retired)

> 本设计文档已退役，仅保留路径用于历史链接。它描述的 runtime factory、session runtime adapter 和 daemon-owned child execution 已不属于当前代码。

当前权威文档：

- [Daemon Application Architecture](./daemon-application-architecture.md)
- [Agent Runtime Framework Architecture](./agent-runtime-framework-architecture.md)
- [Agent Framework Capability Boundary](./agent-framework-capability-boundary.md)
- [Agent Child Session Flow](./agent-child-session-flow.md)
- [Permission Flow](./permission-flow.md)

当前核心关系：

```text
AgentPool caches OpenHarnessAgent per durable sessionId
SessionRunExecutor calls OpenHarnessAgent.submitMessage directly
AgentChildManager owns child execution and live handles
daemon projections own durable session/run/task/transcript/permission state
```
