# Swarm 子进程派发运行流程（D.1 + D.2）

`agent` 工具如何把一个子代理（teammate）作为独立 `ohs --print` 子进程拉起、
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
| `buildTeammateCommand` | `apps/cli/src/teammate.ts` | 配置 → `ohs --print …` 的 argv |
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
│  Teammate 进程 · ohs --print（一次性，跑完即退出）                    │
│                                                                     │
│  Explore / Plan / worker 等人格（-s systemPrompt）                   │
│  继承父 model / provider / permission-mode（api-key 不进 argv）      │
│  可选 isolate → 独立 git worktree（SubprocessBackend + WorktreeManager）│
└─────────────────────────────────────────────────────────────────────┘
```

**包边界（和 README「分层」对齐）：**

| 层 | 谁 | 做什么 |
|----|-----|--------|
| 工具层 | `Agent` / `TaskWait` | LLM 的 spawn / join 入口 |
| swarm 层 | `SubprocessBackend` | 不依赖 services，只认 `TaskRunner` 接口 |
| CLI 层 | `buildTeammateCommand` | 配置 → `ohs --print …` argv |
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
│    ├─ buildTeammateCommand → [node, ohs, --print, …]     │
│    └─ TaskManager.createShellTask({ argv, type:"agent" })│
│                                                          │
│  立即返回 LLM："Spawned … task_id=task_1"（不阻塞）       │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│ Step 3 · Teammate 子进程（后台）                          │
│                                                          │
│  ohs --print + Explore 人格                               │
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
- Teammate 是 **one-shot** `--print`，不支持 `SendMessage` 多轮（会抛错）。
- Teammate argv 自动带 **`--swarm-worker`**（D.4）：只读工具集自动放行，**Explore/Plan 在父进程 `default` 下即可工作**；写/执行类工具（Write/Edit/Bash 等）仍会被拒（`--print` 无交互确认）。

---

## TUI 侧路（仅 `--tui`，与主路径并行）

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

REPL / 普通 `--print` 模式下没有 BackendHost，**不会** emit `swarm_status`。

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
  接口拿 `createShellTask`，真实 `TaskManager` 在 `bootstrap()` 注入。
- **同一个单例**：派发（SubprocessBackend）、取结果（TaskWait）、emit 状态（BackendHost）
  都用 **全局 `getTaskManager()` 单例**，三者对得上。
- **一次性 `--print`**：teammate 跑一轮即退出；足够覆盖 Explore/Plan/verification。
- **配置继承**：argv 带 `--model (config.model ?? settings.model)`、provider/permission-mode、
  `-s <人格>`、**`--swarm-worker`**；**不把 api-key 放 argv**，teammate 复用 `settings.json` + 继承 env。
- **只读自动放行（D.4）**：`--swarm-worker` → `PermissionChecker.autoApproveTools = READ_ONLY_TOOLS`
  （Read/Glob/Grep/WebFetch/WebSearch/TaskGet/TaskList/TaskOutput/TaskWait/CronList/Lsp）；
  `deniedTools` 仍优先于 autoApprove。
- **TaskWait（D.2）**：阻塞 `awaitTask`，per-item 错误隔离，超时返回提示而非挂死；
  Agent 工具描述与 coordinator prompt 都引导用它、别 Sleep 轮询。
- **swarm_status（D.2）**：teammate（`type:"agent"`）任务 created/completed 时 emit，
  点亮前端 SwarmPanel（状态枚举 running/idle/done/error）。

## 使用前提

teammate **继承父进程的 `--permission-mode`**，且 argv 一律带 **`--swarm-worker`**（由
`buildTeammateCommand` 注入，用户无需手动传）。

| 场景 | 父进程 permission | 是否够用 |
|------|-------------------|----------|
| Explore / Plan / verification（只读探索、规划、验证） | `default`（默认） | ✅ 只读工具自动放行 |
| worker（写代码、跑 Bash/测试） | `default` | ❌ Write/Edit/Bash 等需确认，`--print` 无 UI → 等同拒绝 |
| worker 或任意需写/执行的 teammate | `full_auto` 或 `--dangerously-skip-permissions` | ✅ |

`--print` 模式下没有 `permissionPrompt`：`checkTool` 返回 `ask` 时默认 **不允许**（见
`QueryEngine`：无 prompt 则 `allowed = false`）。D.4 的 `--swarm-worker` 让只读工具直接
`allow`，绕过这一步。

```bash
# 只读 Explore：默认 permission 即可
ohs "用一个 Explore 子 agent 看看 packages/core 的结构，再汇总"

# worker 写代码 / 跑测试：父进程需 full_auto
ohs --permission-mode full_auto "用 worker 子 agent 修这个 bug"

# TUI 下 SwarmPanel 可视化（permission 要求同上，与 REPL/--print 一致）
ohs --tui
```

## 留待后续

- **SwarmPanel duration 实时滚动**：当前只在 created/completed emit，运行中显示 ~0s；
  需补一个周期性 `updated` 事件。
- **多轮 `sendMessage`**：需长驻 worker 模式（当前 subprocess teammate 抛错）。
- **写操作转 leader 审批 / 文件邮箱**：完整版 permission_sync（D.4 只做了只读 autoApprove）。
