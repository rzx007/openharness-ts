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
| `PermissionPrompt` 类型 | `packages/core/src/types/runtime.ts` | `(toolName, reason?) => Promise<boolean>` |
| `askPermission`（TUI 后端）| `apps/cli/src/commands/main.ts` | 把"问用户"翻成 `modal_request` 事件，等前端回 `permission_response` |
| `ModalHost` | `apps/frontend/src/components/ModalHost.tsx` | 渲染 permission 框（tool_name + reason + y/n）|
| `App.tsx` 输入处理 | `apps/frontend/src/App.tsx` | 捕获 y/n 按键 → `sendRequest(permission_response)` |

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
| **TUI**（`--tui` 的后端 `--backend-only`）| `runBackendHost` | ✅ `askPermission`（main.ts:645）| 弹 ModalHost，用户 y/n |
| **REPL**（交互式）| `runRepl`（main.ts:239）| ❌ 不传 | **自动拒绝**（无交互确认）|
| **print**（`--print` 一次性）| `runPrintMode`（main.ts:191）| ❌ 不传 | **自动拒绝**（无交互确认）|

所以当前**只有 TUI 能"问用户并放行"**；REPL/print 下 `ask` 一律变拒绝。
（实战中常配 `--permission-mode full_auto` 或 allowed/denied 名单来规避 REPL/print 的 ask。）

## TUI 下"问用户"的跨进程往返

TUI 是**启动器 + 前端（Ink）+ BackendHost（`--backend-only`）三进程**，靠 OHJSON 行协议通信；详见 [tui-flow.md](./tui-flow.md)。
一次权限确认的完整往返：

```
QueryEngine（后端进程）
   │ decision==="ask"
   ▼
askPermission(toolName, reason)              main.ts:614
   │ 生成 request_id；建一个待 resolve 的 Promise，存入 permissionRequests[request_id]
   ▼
emit modal_request {                          后端 → 前端
   kind:"permission", request_id, tool_name, reason
}
   ▼
前端收到 → session.setModal(...)              App.tsx
   ▼
ModalHost 渲染 permission 框                  ModalHost.tsx:97
   ┌ Allow <tool_name>?
   │ <reason>
   └ [y] Allow   [n] Deny
   ▼
用户按 y / n / Esc                            App.tsx:172
   │ sendRequest permission_response { request_id, allowed }   前端 → 后端
   ▼
后端 onRequest 收到 permission_response       main.ts:733
   │ permissionRequests[request_id].resolve(allowed)
   ▼
askPermission 的 await 返回 → QueryEngine 拿到 boolean，放行或拒绝
```

要点：
- **request_id 串起一次确认**：后端用它把异步 resolve 和前端回包对上号。
- ModalHost 当前只显示 `tool_name` + `reason`（**无 diff**）；按键只有 y（allow）/ n、Esc（deny）。
- 是 **fire-and-forget Promise**：后端 emit 后 `await` 挂起，直到前端回 `permission_response` 才 resolve。

---

## E.3 扩展计划：Edit/Write 改文件前的 diff 预览

> 状态：设计已认可，待实现。在上面的「ask」分支与 TUI 往返上做**加法**，不改判定顺序。

### 目标
agent 调 **Edit/Write** 改文件前，在 TUI 权限框里显示 unified diff，让用户看清改动再批准
（**一次** / **整个会话**）；`full_auto` 已自动跳过（checkTool 步骤 1）。

### 现状缺口（本文已确认）
- `PermissionPrompt` 签名 `(toolName, reason?)` **不带工具入参**，拿不到 Edit/Write 的 path/内容。
- `askPermission` 的 `modal_request` 只带 tool_name + reason，**无 diff 字段**。
- ModalHost 只有 y/n，**无 diff 渲染、无"整个会话"选项**。
- **无 diff 库**。
- REPL/print 无 permissionPrompt → 本期 diff 预览**只做 TUI**，不碰 REPL（REPL 连 ask 都没接）。

### 组件（5 小块，跨 core/tools/cli/frontend）
- **a) core**：`PermissionPrompt` 签名加 `input` → `(toolName, reason?, input?) => Promise<boolean>`；
  `executeTools` 把 `tu.input` 传下去。向后兼容（input 可选）。
- **b) tools**：抽**预览纯函数** `computeFileChange(toolName, input) → {path, before, after} | null`
  （**不写盘**，复用 Edit/Write 的替换逻辑；非文件工具返回 null）。
- **c) diff 工具**：加 `diff`(jsdiff) 依赖，`createTwoFilesPatch(before, after)` → unified diff 字符串。
- **d) backend host**：`askPermission` 拿到 input 后，若 Edit/Write → 算 diff，`modal_request` 带 `diff`
  字段；维护**会话批准集合**（"整个会话"按工具名记住，后续同工具的 ask 直接放行）。
- **e) frontend ModalHost**：permission 框渲染 `diff`（+绿 −红），按键 **y**(本次)/**a**(整个会话)/**n**(拒)。

### 分轮
- **R1** core(传 input) + tools(computeFileChange) + diff 工具
- **R2** backend host(算 diff + emit + 会话批准)
- **R3** frontend ModalHost(渲染 diff + a 键)

### 范围外（保持最小）
- 非 Edit/Write 工具不预览（Bash 等无 diff 概念）。
- 不做语法高亮，仅 jsdiff unified diff + 简单 +/− 着色。
- "整个会话批准"**按工具名**粒度，不做按文件路径细粒度。
- REPL/print 的交互式权限确认（当前根本没有，属另一项工作）。

> ⚠️ **"整个会话批准"的锐利边缘**：对某次（哪怕很无害的）Edit 选了 `[a] Allow for
> session`，会把 **Edit 这个工具整体**记入会话批准集合（`approvedForSessionTools`，
> 按工具名）。此后**该 backend 进程存活期间所有 Edit**——包括用户从没看过 diff 的、
> 改其它文件的 Edit——都会被自动放行，且当前**无撤销入口**。这是刻意的最小粒度取舍；
> 若要更细的"按文件/按改动批准"，需引入路径级 scope（后续）。

