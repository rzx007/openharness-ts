# Agent Child Session Flow

> 状态：当前实现。framework owns child execution/live handles；daemon owns durable child session/task/run projection。

## 总图

```mermaid
flowchart LR
  Tool["Agent / SendMessage / Workflow"]
  Manager["AgentChildManager"]
  Registry["tree-wide AgentChildRegistry"]
  Child["child OpenHarnessAgent"]
  Events["shared AgentEventBus"]
  Projector["DaemonAgentEventProjector"]
  Store["child session/run/task/transcript"]
  Directory["LiveChildAgentDirectory"]

  Tool --> Manager --> Child --> Events --> Projector --> Store
  Manager --> Registry
  Manager --> Events
  Projector --> Directory
  Directory -. rootAgent.children .-> Registry
```

## Spawn 闭环

1. Agent/Workflow tool 调用 `context.agent.children.spawnChildAgent()`。
2. `AgentChildManager` 生成 canonical `childId` 与 `sessionId`。
3. `AgentChildEnvironmentProvider` 获取 shared cwd 或 git worktree lease。
4. manager 把 handle 放入 root tree 共享的 `AgentChildRegistry`，发布并等待 `child.created`。
5. daemon projector 创建 durable child session、parent-visible task，并登记 `rootAgent + childId` 路由。
6. framework 递归创建共享 effects/event bus 的 child `OpenHarnessAgent`。
7. child 启动普通 run，发布 input/run/output/tool/terminal events；`run.started` 投影成功且 receipt 与 manager 预分配的 session/input/run ID 完全一致后，spawn receipt 才返回。
8. daemon 使用同一个 event reducer 创建 child input/run/transcript 并绑定/完成 task；child input metadata 由 `input.accepted` 原样携带，application 不再补造记录。

daemon 不向 framework 返回 sessionId、taskId、run host、controls 或 opaque state。task 使用 `childId` 作为可见 ID，因此 Agent 返回的 `task_id` 可直接用于 TaskWait/SendMessage。

## Follow-up

```text
Agent SendMessage
  -> context.agent.children.sendChildInput(childId, input)

HTTP child prompt
  -> SessionApplicationService
  -> LiveChildAgentDirectory.send(childSessionId)
  -> rootAgent.children.get(childId).send(input)

Task input
  -> SessionTaskBridge callback
  -> rootAgent.children.get(childId).send(input)
```

- child 有 active run 且 delivery 不是 queue：调用 `run.steer()`，输入在 turn boundary 注入同一 run。
- active run 正在收尾、不再接受 steer：等待其 settle 后串行启动下一轮。
- delivery=queue 或 child idle：沿 `startChain` 启动下一轮 run，复用 history。
- caller 提供 input ID 时，manager 对未结算请求和最近 256 个已结算请求幂等；相同 ID 不同 payload 失败关闭。daemon 的长期 HTTP 幂等由 durable input/run 关系承担。
- child/grandchild 共用 tree-wide directory，所以 daemon 从 root agent 可以直接路由任意深度 descendant。
- live child HTTP 只返回 receipt 已对应到 durable input/run 的结果；投影缺失或身份不一致会明确失败，不补造第二份 durable 事实。

## Stop / interrupt / close

```text
TaskStop / HTTP interrupt -> child handle.interrupt()
parent run abort          -> manager interrupt(childId)
parent agent close        -> manager.closeAll()
```

close 会 abort active run、等待 settlement、关闭 child 资源、释放 environment lease、发布并等待 `child.closed`，最后从 directory 删除 handle。daemon 收到 terminal/closed event 后完成 durable run/task 并移除 live route。

若 child 普通执行事件投影失败，daemon projector 会先把已建立的 durable run、transcript part 和 parent task 收束为 failed，再把 required event failure 传播给 framework。TaskManager 的 live completion 失败不会阻止 durable task terminal 落盘；durable completion 自身失败则由 `child.closed` 向上传播，不能静默吞掉。

durable task 已 terminal 后，延迟到达的 live `pending/running` snapshot 不得让它回退。显式 follow-up 启动新 run 时才重新置为 `running`，并清除上一轮的 `finishedAt/output/error` 与 live output file。

## Suspend / resume

child run 完成后进入 idle。默认 5 分钟无输入：

1. snapshot history。
2. close child MCP/sandbox/runtime。
3. 保留 invocation/handle/session identity。
4. 发布 `child.suspended`。

后续输入创建新 child agent、load history、发布 `child.resumed`，再执行新 run。

## 所有权

| 状态 | 所有者 |
|---|---|
| child ID、instance、run、abort、result、history | `AgentChildManager` |
| root tree 的 descendant handle 索引 | framework `AgentChildRegistry` |
| worktree acquire/release | framework child environment provider |
| child session/input/run/task/transcript | daemon `SessionStore` + projector |
| childSessionId -> rootAgent/childId 路由 | daemon `LiveChildAgentDirectory` |
| task callbacks | daemon `SessionTaskBridge` |

## 代码位置

```text
packages/agent-runtime/src/child-agent.ts
packages/agent-runtime/src/child-environment.ts
packages/tools/src/agent/index.ts
packages/tools/src/agent/workflow-runner.ts
packages/server/src/http/daemon-agent-event-projector.ts
packages/server/src/http/live-child-agent-directory.ts
packages/server/src/http/session-task-bridge.ts
packages/server/src/http/session-application-service.ts
```
