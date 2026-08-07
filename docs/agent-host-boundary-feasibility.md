# Agent Host Boundary 可行性结论

> 日期：2026-08-07
>
> 当前状态：方向可行，且 Phase 0-5B 已落地到当前代码。`RuntimeHostPort` 已成为 `SessionRuntime.runPrompt(input, host)` 的主边界；permission、runtime event、child-agent invocation 都通过这个 run-scoped host 进入 daemon。

## 1. 结论

可以把 permission approval 和 child agent lifecycle 从 daemon 专属回调/桥，演进为 framework/runtime 层可理解的 host capability：

```text
framework/runtime owns live handles
host/daemon owns transport + durable projection
store owns audit/recovery truth
```

这符合主流 agent runtime 的方向：

- approval 通常被建模为 run interruption 或 tool middleware。
- child/sub-agent 通常被建模为 invocation handle 或 sub-agent-as-tool。
- durable recovery 只有在 run state 可序列化时才能跨重启继续；否则 pending live handle 必须终态化。

## 2. 当前 OpenHarness 落地

```text
SessionRunExecutor
  -> DaemonChildAgentHost
  -> DaemonRuntimeHostPort
  -> runtime.runPrompt(input, host)
  -> CliSessionRuntime
  -> QueryEngine.submitMessage(..., { runtimeHost: host })
  -> ToolContext.runtimeHost
```

已删除/收束的旧入口：

| 旧入口 | 当前入口 |
|---|---|
| `permissionPrompt` | `RuntimeHostPort.requestPermission()` |
| `runtimeEventSink` | `RuntimeHostPort.emitEvent()` |
| `SessionRuntimeHooks` | `RuntimeHostPort` |
| runtimeFactory `childSessionHost/sessionTaskBridge` | run-scoped `DaemonChildAgentHost` |
| Agent tool `ChildSessionBackend` | `ToolRuntimeHost.spawnChildAgent()` |
| CLI `registerChildSessionBackend()` | 已删除 |

## 3. Permission 判断

permission 可以由 framework/runtime 发起，但 daemon 仍必须负责投影：

```text
QueryEngine
  -> runtimeHost.requestPermission()
  -> DaemonRuntimeHostPort
  -> StorePermissionBroker
  -> PermissionController live handle
  -> SessionStore durable request
  -> HTTP/SSE reply
```

边界：

| 能力 | 归属 |
|---|---|
| 是否需要 ask | `QueryEngine` / permission policy |
| live promise/resolve/expire | `PermissionController` |
| durable request/decision | `SessionStore` via `StorePermissionBroker` |
| UI/HTTP transport | daemon routes + SSE |

## 4. Child Agent 判断

child agent lifecycle 放到 host 处理是合适的。Agent tool 只依赖抽象 invocation port：

```text
Agent tool
  -> ToolRuntimeHost.spawnChildAgent()
  -> ChildAgentInvocation { id, taskId, sessionId, result, worktree? }
```

daemon 实现负责 heavy state：

```text
DaemonChildAgentHost
  -> create child session
  -> register parent-visible task
  -> admit child prompt
  -> await child run
  -> complete task projection
  -> interrupt/archive/cleanup worktree
```

边界：

| 能力 | 归属 |
|---|---|
| Agent tool schema/subagent selection | tools/coordinator |
| live invocation id/result | runtime host / `DaemonChildAgentHost` |
| child session/run durable truth | `SessionStore` |
| parent-visible task | `SessionTaskBridge` projection |
| isolated worktree | daemon child host |

## 5. 调研启发

| 生态 | 相关模式 | 对 OpenHarness 的启发 |
|---|---|---|
| OpenAI Agents SDK | HITL approval / interruptions / handoffs | permission 应该是 run-level 可观察事件，不是散落 callback |
| LangGraph | `interrupt()` + checkpointer + subgraph persistence | live pause 与 durable resume 要明确区分 |
| Microsoft Agent Framework | tool approval middleware | approval 放 framework/middleware 层是常见模式 |
| AutoGen / LlamaIndex | teams / sub-agent-as-tool | child agent 可以是 invocation，而不是 daemon child session 的唯一形态 |

## 6. 当前仍需谨慎的点

1. `PermissionController` live handle 不能跨 daemon restart。重启后只能依赖 store projection 终态化。
2. `DaemonChildAgentHost` 里的 invocation map 是 run 内存态；durable truth 是 child session/run/task。
3. `TaskWait` 面向用户的是 task projection，不是 child invocation 本体。
4. `ChildSessionBackend` 仍可能作为历史/测试/独立 swarm 概念存在，但不再是 Agent tool 主路径。

## 7. 后续建议

1. 把 core 的 `QueryRuntimeHost` 进一步稳定成 framework API。
2. 抽出 server-local worktree helper，补独立测试。
3. 明确 child invocation 的 restart 语义：live-only、recover-by-session，还是未来 serialized run state。
4. 删除或重命名过时的 swarm backend 文档和类型，减少误导。
