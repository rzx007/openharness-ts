# Swarm 子进程派发运行流程（D.1 + D.2）

`agent` 工具如何把一个子代理（teammate）作为独立 `ohs --task-worker` 子进程拉起、
后台运行，leader 用 `TaskWait` 阻塞取回结果，并在 TUI 的 SwarmPanel 显示状态。
这是 swarm 当前的最小可用多 Agent 闭环。

- **D.1**：subprocess 派发后端（spawn → 后台子进程 → 轮询取结果）。
- **D.2**：用 `TaskWait` 阻塞等待替代 Sleep 盲轮询；emit `swarm_status` 点亮 SwarmPanel。
- **D.4**：teammate 带 `--swarm-worker`，只读工具自动放行（Explore/Plan 默认 permission 即可）。

## 涉及的模块

| 组件 | 文件 | 职责 |
|------|------|------|
| `agent` 工具 | `packages/tools/src/agent/index.ts` | LLM spawn 入口，取后端并派发，返回 task_id |
| `TaskWait` 工具 | `packages/tools/src/task/index.ts` | leader 阻塞等待 teammate 完成并取结果（D.2）|
| `SubprocessBackend` | `packages/swarm/src/subprocess.ts` | 实现 `SwarmBackend`，经 `TaskRunner` 派发 |
| `buildTeammateCommand` | `apps/cli/src/teammate.ts` | 配置 → `ohs --task-worker …` 的 argv（prompt 经 stdin） |
| 后端注册 | `apps/cli/src/runtime.ts`（bootstrap） | 注册 subprocess 后端 + 给 teammate 任务打 `type:"agent"` 标 |
| `TaskManager` | `packages/services/src/tasks/index.ts` | 真正 spawn 子进程、捕获输出；`awaitTask`/`registerTaskListener`（D.2）|
| swarm_status emit | `apps/cli/src/commands/main.ts` + `swarm-status.ts` | 订阅任务状态，emit `swarm_status`（D.2）|
| SwarmPanel | `apps/frontend/src/components/SwarmPanel.tsx` | TUI 显示 teammate 列表 + 状态 |

## 整体模型（两进程 + 一个单例）

Swarm 当前是 **Leader 进程** 派 **Teammate 子进程**，两者通过 **TaskManager 单例** 衔接：

```
┌─────────────────────────────────────────────────────────────────────┐
│  Leader 进程 · ohs（REPL / --print / --tui 的后端）                  │
│                                                                     │
│  ┌──────────────┐    tool call     ┌────────────┐    spawn        │
│  │ QueryEngine  │ ───────────────► │ Agent 工具 │ ───────────────┐│
│  │ （主 LLM）   │                  └────────────┘                ││
│  └──────┬───────┘                                                ││
│         │ tool call                                              ││
│         │         ┌────────────┐    awaitTask                   ││
│         └────────►│ TaskWait   │ ◄──────────────────────────────┤│
│                   │ 工具       │                                 ││
│                   └────────────┘                                 ││
│                          ▲                                       ││
│                          │ 读日志 / 等终态                        ││
│                   ┌──────┴───────────────────────────────────┐   ││
│                   │ TaskManager 单例 · getTaskManager()      │◄──┘│
│                   │  spawn · 捕获 stdout · 写 task 日志       │    │
│                   └──────────────────┬───────────────────────┘    │
└──────────────────────────────────────┼────────────────────────────┘
                                       │ spawn 子进程
                                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Teammate 进程 · ohs --task-worker（读一行跑一轮即退;可重启多轮）     │
│                                                                     │
│  Explore / Plan / worker 等人格（-s systemPrompt）                   │
│  继承父 model / provider（api-key 不进 argv）                        │
│  permission-mode 缺省 default（不继承父；可经 permissionMode 覆盖）   │
│  可选 isolate → 独立 git worktree（SubprocessBackend + WorktreeManager）│
└─────────────────────────────────────────────────────────────────────┘
```

**包边界（和 README「分层」对齐）：**

| 层 | 谁 | 做什么 |
|----|-----|--------|
| 工具层 | `Agent` / `TaskWait` | LLM 的 spawn / join 入口 |
| swarm 层 | `SubprocessBackend` | 不依赖 services，只认 `TaskRunner` 接口 |
| CLI 层 | `buildTeammateCommand` | 配置 → `ohs --task-worker …` argv |
| 服务层 | `TaskManager` | 真 spawn、日志、`awaitTask`、状态 listener |

`bootstrap()` 里把三者接成一条链：`SubprocessBackend` → `TaskRunner` 适配器（强制 `type:"agent"`）→ `TaskManager`。

---

## Swarm teammate 运行流程（主路径）

这是 Leader LLM **必须走的两步工具调用**（D.2 之后不再 Sleep 盲轮询）：

```
用户："用 Explore 子 agent 看 packages/core"
         │
         ▼
┌──────────────────────────────────────────────────────────┐
│ Step 1 · Leader 决策                                      │
│ LLM 根据任务委派 → 调用 Agent 工具                         │
│   { subagentType:"Explore", prompt:"...", description }  │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│ Step 2 · Agent 工具（packages/tools/src/agent）           │
│                                                          │
│  getAgentDefinition(subagentType)  → 人格 systemPrompt   │
│  getBackendRegistry().getExecutor("subprocess")            │
│  SubprocessBackend.spawn(config)                         │
│    ├─ buildTeammateCommand → [node, ohs, --task-worker]  │
│    └─ TaskManager.createAgentTask({argv,prompt,type:…}) │
│                                                          │
│  立即返回 LLM："Spawned … task_id=task_1"（不阻塞）       │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│ Step 3 · Teammate 子进程（后台）                          │
│                                                          │
│  ohs --task-worker + Explore 人格(prompt 经 stdin)        │
│  自己的 QueryEngine 跑一轮 → stdout 写入 task 日志         │
│  正常结束 exit 0 / 失败非 0                               │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│ Step 4 · Leader 取结果                                    │
│ LLM 调用 TaskWait{ taskIds:["task_1"], timeoutSeconds }   │
│                                                          │
│  TaskManager.awaitTask(task_1)  阻塞直到终态或超时        │
│  返回可读摘要："task_1 (completed): <输出>"               │
│                                                          │
│  ✗ 旧 D.1：Sleep + TaskGet/TaskOutput 循环轮询            │
│  ✓ 新 D.2：一次 TaskWait 阻塞 join                        │
│  ✓ 多个 teammate：spawn 多次 → 一次 TaskWait 并行等       │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
                    Leader 汇总回复用户
```

**要点：**

- Subagent **不是**框架自动识别用户话术；是 Leader LLM **主动调 `Agent` 工具**。
- Teammate 走 `--task-worker`：读一行 stdin 跑一轮即退；**SendMessage 多轮可用**——写 stdin 时 TaskManager 懒复活重启进程（重启不保留上下文，与 Python 同）。
- Teammate argv 自动带 **`--swarm-worker`**（D.4）：只读工具集自动放行，**Explore/Plan 在父进程 `default` 下即可工作**；写/执行类工具经 D.5 权限文件流转 leader 裁决（leader 没放行则拒）。

---

## TUI 侧路（仅 `--tui`，与主路径并行）

> TUI 三进程启动与 OHJSON 协议见 [tui-flow.md](./tui-flow.md)。

SwarmPanel **不参与** Leader 取结果，只是可视化；只有 TUI 的 BackendHost 会 emit：

```
TaskManager.registerTaskListener
         │  仅 type === "agent" 的任务
         ▼
BackendHost（--backend-only）
         │  OHJSON 事件 swarm_status
         ▼
SwarmPanel（React/Ink）

created   → status: running
completed → status: done / error（按 exitCode）
```

REPL / 普通 print 模式下没有 BackendHost，**不会** emit `swarm_status`。

---

## 和 D.1 的对比

| | D.1 | D.2（当前） |
|---|-----|------------|
| 取结果 | Sleep + TaskGet/TaskOutput 轮询 | **TaskWait** 一次阻塞 |
| UI | 无 | TUI 下 **swarm_status** → SwarmPanel |
| 任务标记 | — | subprocess 任务统一 `type:"agent"` |

---

## 关键点

- **解耦**：`swarm` 不直接依赖 `services`；`SubprocessBackend` 经结构化 `TaskRunner`
  接口拿 `createAgentTask`/`writeToTask`，真实 `TaskManager` 在 `bootstrap()` 注入。
- **同一个单例**：派发（SubprocessBackend）、取结果（TaskWait）、emit 状态（BackendHost）
  都用 **全局 `getTaskManager()` 单例**，三者对得上。
- **task-worker 一轮一进程**：读一行 stdin 跑一轮即退；SendMessage 触发懒复活重启（重启不保留上下文）。
- **配置继承**：argv 带 `--model (config.model ?? settings.model)`、provider、
  `-s <人格>`、**`--swarm-worker`**；**不把 api-key 放 argv**，teammate 复用 `settings.json` + 继承 env。
- **权限模式不继承**：`--permission-mode` 取 `config.permissionMode ?? "default"`，不读父进程
  settings。继承会形成死循环：leader full_auto → worker 也 full_auto 自行放行，D.5 文件流的
  批准路径成为死代码。worker 固定 default 后写操作经文件流由 leader 集中裁决（leader full_auto
  时 checker 照批，但留下集中审计点）。Agent 工具的 `permissionMode` 入参可显式覆盖。
- **只读自动放行（D.4）**：`--swarm-worker` → `PermissionChecker.autoApproveTools = READ_ONLY_TOOLS`
  （Read/Glob/Grep/WebFetch/WebSearch/TaskGet/TaskList/TaskOutput/TaskWait/CronList/Lsp）；
  `deniedTools` 仍优先于 autoApprove。
- **TaskWait（D.2）**：阻塞 `awaitTask`，per-item 错误隔离，超时返回提示而非挂死；
  Agent 工具描述与 coordinator prompt 都引导用它、别 Sleep 轮询。
- **swarm_status（D.2）**：teammate（`type:"agent"`）任务 created/completed 时 emit，
  点亮前端 SwarmPanel（状态枚举 running/idle/done/error）。

## 使用前提

teammate 的 `--permission-mode` **缺省一律 `default`（不继承父进程）**，且 argv 一律带
**`--swarm-worker`**（由 `buildTeammateCommand` 注入，用户无需手动传）。Agent 工具的
`permissionMode` 入参可按 teammate 显式覆盖。

| 场景 | leader permission | worker 行为 |
|------|-------------------|-------------|
| Explore / Plan / verification（只读探索、规划、验证） | `default`（默认） | ✅ 只读工具自动放行（D.4） |
| worker（写代码、跑 Bash/测试） | `default` | ❌ 写操作经文件流转 leader，leader checker `ask`→拒（带 reason 回传） |
| worker（写代码、跑 Bash/测试） | `full_auto` 或配 allowedTools | ✅ 写操作经文件流转 leader，checker `allow`→批；leader 处留集中审计点 |

注意：leader 自己跑 `default` 时，**Agent 工具本身**在 `--print`/REPL 下也会因
`ask` 即拒派不出去（无 `permissionPrompt`，见 `QueryEngine`：无 prompt 则
`allowed = false`）——派写型 worker 的实际组合是「leader `full_auto` + worker
缺省 `default`」。

```bash
# 只读 Explore：默认 permission 即可
ohs "用一个 Explore 子 agent 看看 packages/core 的结构，再汇总"

# worker 写代码 / 跑测试：leader 开 full_auto，worker 仍以 default 跑、
# 写操作经文件流由 leader 自动裁决
ohs --permission-mode full_auto "用 worker 子 agent 修这个 bug"

# TUI 下 SwarmPanel 可视化（permission 要求同上，与 REPL/--print 一致）
ohs --tui
```

## D.5 之后：写操作转 leader 审批

D.5 落地了文件邮箱 + team.json 持久化 + 权限同步（设计与差异见
[swarm-file-infra-design.md](./swarm-file-infra-design.md)）。teammate 的写/执行类
工具不再「无确认即拒」：

```
worker（teammate 进程）                     leader 进程
  checkTool → ask
  permissionPrompt（swarm 版）
    │ 写 pending/<id>.json                   后台裁决器（1s 轮询 watch 的团队）
    │ 0.5s 轮询 resolved/，60s 超时    ◄──── readPendingPermissions
    │                                        handlePermissionRequest(checker)
    │                                          只读→批；其余 allow→批、deny/ask→拒
    ▼                                        resolvePermission → resolved/<id>.json
  approved → 放行工具；其余 → 拒
```

- spawn 时注入 env `CLAUDE_CODE_TEAM_NAME/AGENT_ID/AGENT_NAME`，成员写进
  `~/.openharness/teams/<team>/team.json`；本会话隐式建的团队随 leader 退出清理
  （exit/SIGINT/SIGTERM）。
- leader 是 `default` 模式时写操作仍会被拒（checker `ask`→拒）；要让 worker 写盘，
  leader 开 `full_auto` 或配 allowedTools——与上文表格语义一致，但现在拒绝
  发生在 leader 裁决处、带 reason 回传。
- worker 缺省固定 `default`（不继承 leader 的 full_auto），保证写操作必然走这条
  文件流；需要特例（如信任的自动化流水线）时经 Agent 工具 `permissionMode: "full_auto"`
  显式放开。

## 留待后续

- **SwarmPanel duration 实时滚动**：当前只在 created/completed emit，运行中显示 ~0s；
  需补一个周期性 `updated` 事件。
- ~~多轮 `sendMessage`~~：已落地（task-worker 重启式多轮，见 [swarm-task-worker-design.md](./swarm-task-worker-design.md)）。留待：重启时经 session 快照恢复上下文。
- **`ask` 转 TUI 人工裁决**：当前 leader checker 自动裁决；可在 ask 分支接 E.3 权限弹框。
