# @openharness/services

共享服务：daemon `SessionStore`、严格版本的 standalone session 文件、Scheduled Tasks 重复规则、执行记录、LspClient 和 Memory 辅助能力。Runtime 上下文压缩只使用 `@openharness/core` 的 `CompactService`。

## 功能

- **Scheduled recurrence**: 校验一次性时间和 RRULE，并按时区计算下一次运行时间
- **SessionStore**: daemon 权威 session/input/message/part/event/run/permission 持久化
- **standalone session files**: 只接受当前 schema 的项目级 snapshot 与 transcript 导出；不供 daemon/TUI 保存权威状态
- **LspClient**: 代码智能服务 (stub；ripgrep 查询走统一 Sandbox argv 入口)
- **Execution services**: detached process 和 framework child 的进程内句柄；durable 投影仍由 daemon 保存

外部工作负载进程不在 services 内直接 `spawn/exec`：`DetachedProcessSupervisor`、autodream 和 LSP 查询统一委托 `@openharness/sandbox`。framework child Agent 的回调句柄只放在 `ChildAgentExecutionRegistry`；跨端执行投影与 Scheduled Task 状态仍由 daemon `SessionStore` 持久化。

## 测试

```bash
pnpm --filter @openharness/services test
```
