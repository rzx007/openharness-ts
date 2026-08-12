# Agent SDK Public Surface

> 状态：已完成。权威使用文档见 [OpenHarness Agent SDK](../../agent-sdk.md)。

## 目标

把 `OpenHarnessAgent` 收口为 standalone、daemon、channels 共用的唯一 programmatic 入口；framework 保持 OpenHarness opinionated defaults，不扩张为通用 runtime framework。

## 完成项

- [x] 创建参数扁平化，删除 `overrides` 与 public runtime factory 入口。
- [x] `requestPermission` 作为显式 effect callback。
- [x] `onEvent` 作为 ordered reliable host sink。
- [x] `agent.subscribe()` 作为多 observer、错误隔离的 observation API。
- [x] daemon `AgentPool` 只创建/缓存 `OpenHarnessAgent`，不绑定 QueryEngine/runtime factory。
- [x] channels 改用 agent run handle，并在 shutdown 时 interrupt active run。
- [x] provider URL 与 credential resolution 回归所属 package。
- [x] 增加无 daemon 的完整 SDK 回合测试。
- [x] 更新权威文档并删除旧概念稿、旧 event/host ADR、旧 session runtime 设计和旧 channels 设计。

## 不变量

```text
framework = execution + live state + live handles
daemon    = durable session/task/run/transcript + HTTP/SSE + multi-client policy
surface   = interaction and rendering
```

daemon 的 durable projector 可以作为 `onEvent` callback 实现，但 framework 不认识 projector、store、HTTP 或 durable schema。

## 验证

- 30/30 package TypeScript checks passed.
- agent-runtime 38 tests、channels 43 tests、auth 25 tests、api 57 tests、server 159 tests、client 30 tests、CLI 182 tests passed.
- 全仓并行测试的 SDK 相关包全部通过；`packages/tools` 仍有 3 个独立 Windows/ripgrep 测试失败：`.gitignore` 匹配 1 个、临时目录 `EBUSY` 清理 2 个。本任务未修改 tools。
