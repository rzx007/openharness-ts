# 设计：Swarm 文件基础设施 + 权限同步（D.5）

> 状态：已批准。建立在 swarm D.1–D.4（subprocess 派发、TaskWait、worktree 隔离、
> 只读自动放行）之上，收口 PLAN-REMAINING「Swarm 真实派发」的剩余三块：
> 文件邮箱、team.json 持久化、权限同步。

## 背景与关键发现

Python v0.1.9 的 `mailbox.py` / `team_lifecycle.py` / `permission_sync.py` 是
**孤岛库**：除自身与测试外，整个 Python 仓库没有任何引擎/CLI 调用方（docstring
表明它们是对照 claude-code 的 teamHelpers.ts 移植的基础设施，尚未接线）。

经决策（用户选 B）：**库忠实移植 + TS 自有接线**。接线部分超出 Python 原版，
在「与 Python 差异」一节明确标注；裁决逻辑沿用 Python `handle_permission_request`
语义（checker 自动裁决，不弹框）。

## 目录布局（对齐 Python）

```
~/.openharness/teams/<team>/
├── team.json                        # 团队元数据（R2）
├── agents/<agentId>/inbox/          # 文件邮箱（R1）
│   ├── <timestamp>_<msgId>.json     # 每条消息一个文件
│   └── .write_lock                  # 邮箱写锁
└── permissions/                     # 权限同步（R3）
    ├── pending/<requestId>.json     # worker 写入待裁决请求
    ├── pending/.lock
    └── resolved/<requestId>.json    # leader 裁决后移入
```

环境变量沿用 Python 命名：`CLAUDE_CODE_TEAM_NAME` / `CLAUDE_CODE_AGENT_ID` /
`CLAUDE_CODE_AGENT_NAME` / `CLAUDE_CODE_AGENT_COLOR`。

---

## R1 — 文件锁 + 文件邮箱（`packages/swarm`）

### `lockfile.ts`

`exclusiveFileLock<T>(lockPath, fn): Promise<T>`：

- 获取：`fs.open(lockPath, "wx")` 独占创建；`EEXIST` 时每 50ms 重试。
- 陈旧回收：锁文件 mtime 超过 10s 视为持有者崩溃，删除后重试获取。
- 释放：`finally` 中 unlink。
- 总获取超时（如 30s）后抛 `SwarmLockError`。

### `mailbox.ts`

忠实移植 Python `mailbox.py`：

- `MailboxMessage`：`{ id, type, sender, recipient, payload, timestamp, read }`；
  `type` 联合含全部 7 种（`user_message` / `permission_request` /
  `permission_response` / `sandbox_permission_request` /
  `sandbox_permission_response` / `shutdown` / `idle_notification`）。
- `TeammateMailbox(teamName, agentId)`：
  - `write(msg)`：锁内 `.tmp` 写 + rename 原子落盘，文件名 `<timestamp>_<id>.json`
    （timestamp 6 位小数定宽，保字典序==时间序）。
  - `readAll(unreadOnly=true)`：按文件名排序、跳过 `.`/`.tmp`/损坏 JSON；
    收件箱不存在视为空。
  - `markRead(messageId)`：锁内原位更新 `read:true`；收件箱不存在则 no-op。
  - `clear()`：锁内删除全部消息文件；收件箱不存在则 no-op。
- 目录助手：`getTeamDir(team, {ensure?})` / `getAgentMailboxDir(team, agentId, {ensure?})`
  （默认纯路径计算，写路径显式传 `ensure:true` 才 mkdir -p）。
- 工厂：`createUserMessage` / `createShutdownRequest` / `createIdleNotification` /
  `createPermissionRequestMessage` / `createPermissionResponseMessage`。
- 类型守卫：`isPermissionRequest` / `isPermissionResponse`（兼容 payload.text
  内嵌 JSON 的信封格式）。
- `writeToMailbox(recipientName, message, teamName?)`：全局便捷函数，从
  message.text 嗅探消息类型路由；team 缺省取 `CLAUDE_CODE_TEAM_NAME` → `"default"`。

现有内存版 `Mailbox` 类**保留不动**（Python 同样双轨并存）。

---

## R2 — team.json 持久化（`team-lifecycle.ts`）

忠实移植 Python `team_lifecycle.py`：

- `sanitizeName`（非字母数字→`-`、小写）/ `sanitizeAgentName`（`@`→`-`）。
- 数据类：`AllowedPath`、`TeamMember`（**字段全保留**，含 `tmux_pane_id` 等
  pane 字段以保 schema 兼容）、`TeamFile`。JSON 读取 snake_case 为主、
  camelCase 容错；写出 snake_case。原子写（`.tmp` + rename）。
- 读写：`readTeamFile` / `writeTeamFile`（+ async 包装可省，TS 全 async）。
- `TeamLifecycleManager`（无状态，直接读写盘）：
  `createTeam` / `deleteTeam` / `getTeam` / `listTeams` /
  `addMember` / `removeMember` / `setMemberMode` / `setMemberActive`。
- 独立函数：`removeTeammateFromTeamFile` / `removeMemberByAgentId` /
  `setMultipleMemberModes` / `syncTeammateMode`。
- 会话清理：`registerTeamForSessionCleanup` / `unregisterTeamForSessionCleanup` /
  `cleanupSessionTeams` / `cleanupTeamDirectories`（先 `git worktree remove
  --force` 销毁成员 worktree，失败回退递归删除；再删团队目录）。

---

## R3 — permission_sync + TS 接线

### 库（忠实移植 `permission-sync.ts`）

- 类型：`SwarmPermissionRequest`（snake_case 字段 + camelCase 容错读取）/
  `PermissionResolution` / `PermissionResponse` / `SwarmPermissionResponse`。
- `generateRequestId()`：`perm-<Date.now()>-<rand7>`。
- 文件流：
  - worker：`writePermissionRequest(request)` → `pending/<id>.json`（锁内原子写）。
  - leader：`readPendingPermissions(team)`（oldest-first）→
    `resolvePermission(id, resolution, team)`（锁内 pending→resolved 原子搬移）。
  - worker：`readResolvedPermission(id)` / `pollForResponse(id)`（**单次**查询，
    对齐 Python；0.5s 循环在接线层 `buildSwarmWorkerPermissionPrompt` 里）/
    `deleteResolvedPermission(id)`。
  - 维护：`cleanupOldResolutions(team, maxAgeSeconds=3600)`。
- 角色检测：`isTeamLeader()`（无 agent id 或 `"team-lead"`）/ `isSwarmWorker()`。
- `getLeaderName(team)`：读 team.json 的 `lead_agent_id` 反查名字，缺省 `"team-lead"`。
- 裁决：`handlePermissionRequest(request, checker)` ——
  只读工具（`READ_ONLY_TOOLS`）直接批；其余走 leader 的
  `PermissionChecker.checkTool`：**allow→approved、deny/ask→rejected（带 reason）**。
  leader 没开足够权限（白名单/full_auto）时 worker 写操作仍被拒——保守且可解释。
- mailbox 双轨：`sendPermissionRequestViaMailbox` /
  `sendPermissionResponseViaMailbox` / `sendPermissionRequest` /
  `pollPermissionResponse` / `sendPermissionResponse`。

### 接线（TS 扩展，超出 Python 原版）

1. **spawn 侧**（`SubprocessBackend` + bootstrap）：派发 teammate 时——
   - 确保 team.json 存在（无则 `createTeam` 并 `registerTeamForSessionCleanup`）；
   - `addMember` 登记成员（agent_id / name / backend_type / worktree_path）；
   - 子进程注入 env `CLAUDE_CODE_TEAM_NAME` / `CLAUDE_CODE_AGENT_ID` /
     `CLAUDE_CODE_AGENT_NAME`（需要 TaskManager 的 createShellTask 支持透传 env）。
2. **worker 侧**（print 模式）：`isSwarmWorker()` 为真 → 注入
   `permissionPrompt = async (toolName, reason, input)`：
   `createPermissionRequest` → `writePermissionRequest` → `pollForResponse`
   （60s 超时）→ approved 则放行，超时/拒绝返回 false。
   worker 的写操作从「ask 即死路」变「转 leader 审批」。
3. **leader 侧**：首个 teammate 派发时启动后台轮询器（1s 间隔）：
   `readPendingPermissions` → `handlePermissionRequest(leaderChecker)` →
   `resolvePermission`。全部 `type:"agent"` 任务终态后停止。
4. **退出清理**：leader 进程退出钩子调 `cleanupSessionTeams()`。

---

## 与 Python 差异

| 点 | Python | TS | 原因 |
|----|--------|----|------|
| 锁原语 | `flock`(POSIX) / `msvcrt.locking`(Win)，进程退出自动释放 | `wx` 独占创建锁文件 + 50ms 重试 + 10s 陈旧回收 | Node 无 flock 原语；互斥语义等价，崩溃恢复靠陈旧超时 |
| 锁模块位置 | `utils/file_lock.py`（swarm/lockfile 转 re-export） | `packages/swarm/src/lockfile.ts` | TS 侧暂无其他消费者，避免新增跨包依赖；有需要再上移 utils |
| 引擎接线 | 无（孤岛库） | spawn env 注入 + worker permissionPrompt 文件流 + leader 自动裁决轮询 + 退出清理 | 不接线则零用户价值；裁决语义仍按 Python `handle_permission_request` |
| 裁决映射 | `checker.evaluate().allowed` | `checkTool`: allow→批、deny/ask→拒 | TS checkTool 是三态；ask 视为「leader 也做不了主」保守拒 |
| pane 相关 | `_kill_orphaned_teammate_panes`、hidden_pane helpers | 不做（字段保留） | TS 无 tmux/iTerm pane 后端 |
| sandbox 授权 | 消息工厂 + mailbox 收发 | 仅保留消息类型联合，不做工厂/收发 | TS sandbox 是 stub（D.3 未做） |
| 只读工具集 | `_READ_ONLY_TOOLS`（9 个，snake_case 名） | 复用 `packages/permissions` 的 `READ_ONLY_TOOLS`（11 个，TS 工具名） | 与 D.4 保持单一事实来源 |
| async 形态 | sync + `run_in_executor` 双轨 | 全 async（Node fs/promises） | Node 无需线程池规避阻塞 |
| 路径安全 | `sanitize_name` 定义而未调用，`get_team_dir` 直接拼接 | `getTeamDir`/`getAgentMailboxDir` 校验名字（`[A-Za-z0-9._@-]+`，拒绝 `..`/分隔符）+ 删除前断言在 teams 根之下 | TS 接了线：team/agent 名来自 LLM 工具入参，且团队目录随会话退出递归删除——不校验等于任意目录删除 |
| team.json 锁 | 无锁读-改-写 | 同样无锁（沿用），仅修 createTeam TOCTOU（并行 spawn 撞「already exists」时继续 addMember） | 忠实复刻；并行 spawn 丢成员登记的窗口极小，留待需要时加 `.team_lock` |
| 目录创建时机 | `get_team_dir` 调用即 mkdir | `getTeamDir`/`getAgentMailboxDir` 默认纯路径，写路径显式 `ensure:true` | Python 版查询不存在的团队也留下空目录；读路径不应有写副作用 |
| worker 权限模式 | worker 继承 leader 模式 | 缺省一律 `default`（`TeammateSpawnConfig.permissionMode` / Agent 工具 `permissionMode` 入参可覆盖） | 继承是死循环：leader full_auto → worker 自行放行，文件流批准路径成死代码；固定 default 让写操作必走 leader 集中裁决（审计点） |

## 范围外

- TUI 弹框人工裁决 worker 请求（后续可在 `ask` 分支接 E.3 权限弹框）。
- 长驻 worker / 多轮 `sendMessage`（teammate 仍 one-shot `--print`）。
- sandbox 网络授权实际接线。
- `permission_updates`（"always allow" 规则回写）只存字段不生效。

## 测试

对照移植 Python 测试 + 接线测试：

- `lockfile.test.ts`：互斥（并发临界区）、释放后可再获取、陈旧锁回收、超时抛错。
- `mailbox.test.ts`：原子写落盘格式、readAll 排序/unread 过滤/损坏文件跳过、
  markRead、clear、工厂函数、类型守卫（含 text 信封）、writeToMailbox 类型嗅探。
- `team-lifecycle.test.ts`：CRUD、重复建团队抛错、成员增删改、mode/active、
  snake/camel 容错、清理（含 worktree 路径收集）。
- `permission-sync.test.ts`：写 pending→读→resolve 搬移→pollForResponse、
  超时返回 null、handlePermissionRequest 三态映射、角色检测、getLeaderName。
- 接线：buildTeammateCommand/spawn env 注入、worker permissionPrompt 往返
  （临时目录模拟 leader 裁决）、轮询器启停。

每轮完成 = `pnpm check-types` + `pnpm test` 全绿（pre-commit 已强制）。
