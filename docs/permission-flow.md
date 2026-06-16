# 权限（Permission）流程

工具调用从"决策"到"放行/拒绝/问用户"的完整链路，以及 TUI 下"问用户"的
跨进程往返。E.3（Edit/Write diff 预览）就接在这条链的「ask」分支上，最后一节给出
扩展计划。

## 两层模型：checkTool（规则判定）+ permissionPrompt（问用户）

权限分两层，职责不同：

| 层 | 谁 | 产物 |
|----|-----|------|
| **决策层** | `PermissionChecker.checkTool(name, input)` | `{ action: "allow" \| "deny" \| "ask", reason }` |
| **确认层** | `QueryEngine` + `permissionPrompt` 回调 | 当 action==="ask" 时，问用户拿 `boolean` |

`checkTool` 只按规则给出三态决策，**不**与用户交互；真正"弹框问"由 QueryEngine 在
拿到 `ask` 后调用注入的 `permissionPrompt` 回调完成。

## 涉及的模块

| 组件 | 文件 | 职责 |
|------|------|------|
| `PermissionChecker` | `packages/permissions/src/index.ts` | `checkTool` 规则判定（mode/denied/autoApprove/allowed/path/command/rules）|
| `QueryEngine.executeTools` | `packages/core/src/engine/query-engine.ts` | 对每个工具调用先 checkTool；`ask` → 调 `permissionPrompt` |
| `PermissionPrompt` 类型 | `packages/core/src/types/runtime.ts` | `(toolName, reason?, input?) => Promise<boolean>`（input 供 diff 预览） |
| `askPermission`（TUI 后端）| `apps/cli/src/commands/main.ts` | 把"问用户"翻成 `modal_request` 事件（含 diff/diff_path），等前端回 `permission_response` |
| `PermissionDialog` | `apps/frontend/src/components/dialogs/PermissionDialog.tsx` | 渲染权限框（tool_name + reason + diff 预览 + y/a/n/Esc）|
| `useModalWiring` | `apps/frontend/src/hooks/useModalWiring.tsx` | 把 modal_request 接到 DialogContext；y→once，a→session，n/Esc→deny |

## 决策层：checkTool 的判定顺序

`PermissionChecker.checkTool`（`packages/permissions/src/index.ts:79`）严格按以下顺序，**先命中先返回**：

```
1. mode === "full_auto"          → allow（全自动，跳过一切检查）
2. toolName ∈ deniedTools         → deny  （黑名单永远优先，安全优先）
3. toolName ∈ autoApproveTools    → allow （swarm worker 只读工具自动放行，D.4）
4. allowedTools 非空 且 不含 name → deny  （白名单模式：不在白名单即拒）
5. input.command 命中 deniedCommands → deny（命令模式黑名单）
6. input.path/filePath 命中 pathRules → allow/deny（按 rule.allow）
7. 逐条 rules（tool/path/command 匹配）→ rule.action
8. mode === "plan"                → ask   （计划模式一律要确认）
9. 兜底                            → ask   （无匹配规则，问用户）
```

要点：
- **deny 永远压过 autoApprove**（步骤 2 在步骤 3 之前）——安全优先。
- `READ_ONLY_TOOLS`（Read/Glob/Grep/WebFetch/WebSearch/TaskGet/TaskList/TaskOutput/TaskWait/CronList/Lsp）
  是 swarm worker 经 `--swarm-worker` 灌进 `autoApproveTools` 的集合（见 D.4）。
- `default` 模式下，没有任何白/黑名单或规则命中时，**写/执行类工具走兜底的 `ask`**。

## 确认层：QueryEngine 如何处理三态

`QueryEngine.executeTools`（`query-engine.ts:252`）对一批 `toolUses` 先**并行** checkTool，
再逐个按决策处理：

```
checkTool → decision
   ├─ "deny"  → 直接产出 isError 结果："Permission denied: <reason>"，不执行
   ├─ "ask"   → allowed = permissionPrompt ? await permissionPrompt(name, reason) : false
   │              ├─ allowed=false → isError："Permission denied by user"，不执行
   │              └─ allowed=true  → 继续往下
   └─ "allow" → 继续往下
继续 → pre_tool_use hook（可拦截）→ 执行工具 → post_tool_use hook
```

关键代码（`query-engine.ts:279`）：

```ts
if (decision.action === "ask") {
  let allowed = false;
  if (this.permissionPrompt) {
    allowed = await this.permissionPrompt(toolUse.name, decision.reason);
  }
  if (!allowed) { /* isError: Permission denied by user */ }
}
```

**⚠️ 注意：`permissionPrompt` 是可选注入。若没注入，`ask` 直接当拒绝处理。**

## permissionPrompt 在各运行模式下的接线

`permissionPrompt` 只在 **TUI 后端**接了线（`apps/cli/src/commands/main.ts`）：

| 模式 | 入口 | 是否注入 permissionPrompt | `ask` 的实际效果 |
|------|------|--------------------------|-----------------|
| **TUI**（`--tui` 的后端 `--backend-only`）| `runBackendHost` | ✅ `askPermission` | 弹 PermissionDialog，用户 y/a/n/Esc |
| **REPL**（交互式）| `runRepl` | ❌ 不传 | **自动拒绝**（无交互确认）|
| **print**（`--print` 一次性）| `runPrintMode` | ❌ 不传 | **自动拒绝**（无交互确认）|

所以当前**只有 TUI 能"问用户并放行"**；REPL/print 下 `ask` 一律变拒绝。
（实战中常配 `--permission-mode full_auto` 或 allowed/denied 名单来规避 REPL/print 的 ask。）

## TUI 下"问用户"的跨进程往返

TUI 是**启动器 + 前端（Ink）+ BackendHost（`--backend-only`）三进程**，靠 OHJSON 行协议通信；详见 [tui-flow.md](./tui-flow.md)。
一次权限确认的完整往返：

```
QueryEngine（后端进程）
   │ decision==="ask"
   ▼
askPermission(toolName, reason, input)
   │ 生成 request_id；建一个待 resolve 的 Promise，存入 permissionRequests[request_id]
   │ 若 Edit/Write：computeFileChange(input) → createTwoFilesPatch → unified diff 字符串
   ▼
emit modal_request {                          后端 → 前端
   kind:"permission", request_id, tool_name, reason, diff?, diff_path?
}
   ▼
前端收到 → session.setModal(...)              useBackendSession.ts
   ▼
useModalWiring → DialogContext.replace(PermissionDialog, onClose)
   ┌ Allow <tool_name>?
   │ <reason>
   │ <diff_path>
   │ <DiffView>（diff 预览，可滚动）
   └ [y] Allow   [a] Allow for session   [n/esc] Deny
   ▼
用户按 y / a / n / Esc
   │ sendRequest permission_response { request_id, allowed, scope }   前端 → 后端
   ▼
后端 readline handler 收到 permission_response（不经主循环队列）
   │ scope==="session" → approvedForSessionTools.add(toolName)
   │ permissionRequests[request_id].resolve(allowed)
   ▼
askPermission 的 await 返回 → QueryEngine 拿到 boolean，放行或拒绝
```

要点：
- **request_id 串起一次确认**：后端用它把异步 resolve 和前端回包对上号。
- `permission_response` 在 **readline handler** 中直接 resolve，不入主循环队列，避免 busy 时死锁。
- `scope: "session"` → `approvedForSessionTools` 集合记住该工具名，同名工具后续 ask 直接放行（会话级，无撤销入口，粒度为工具名而非文件路径）。
- Esc 在 PermissionDialog 的 `useKeyboard` 中直接处理（`n/escape → deny`），无需依赖 DialogContext ESC 冒泡。
- 是 **fire-and-forget Promise**：后端 emit 后 `await` 挂起，直到前端回 `permission_response` 才 resolve。

---

## E.3 Edit/Write diff 预览（已实现）

> 状态：✅ 已实现。Edit/Write 改文件前在 TUI 权限框显示 unified diff，支持"整个会话放行"。

### 实现覆盖（5 组件）

- **core**：`PermissionPrompt` 签名 `(toolName, reason?, input?) => Promise<boolean>`，`executeTools` 把 `tu.input` 透传。
- **tools**：`computeFileChange(toolName, input)` 纯函数（不写盘），Edit/Write 返回 `{path, before, after}`，其余返回 null。
- **diff 工具**：`diff`(jsdiff) 依赖，`createTwoFilesPatch` → unified diff 字符串。
- **backend host**：`askPermission` 算 diff 后，`modal_request` 带 `diff`/`diff_path` 字段；`approvedForSessionTools` 集合处理 scope=session。
- **frontend**：`PermissionDialog` 渲染 `DiffView`（可滚动，16行可见区）+ 按键 **y**(本次)/**a**(整个会话)/**n/Esc**(拒)。

### 范围外（已确认）
- 非 Edit/Write 工具不预览（Bash 等无 diff 概念）。
- 不做语法高亮，仅 +/− 着色（`DiffView` 组件）。
- REPL/print 无 permissionPrompt，ask 直接拒绝，不受影响。

> ⚠️ **"整个会话批准"的锐利边缘**：选 `[a]` 后，**同名工具后续所有调用**均自动放行
> （`approvedForSessionTools` 按工具名粒度），当前无撤销入口。若要更细的按文件路径批准，
> 需引入路径级 scope（后续）。

