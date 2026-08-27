# Desktop Session Store 模块化与会话运行态设计

## 背景

`apps/desktop/src/renderer/src/stores/desktop-session-store.ts` 目前同时承担以下工作：

- 应用启动、daemon 状态和全局配置加载；
- 项目选择、Git 状态和分支操作；
- 会话列表、当前会话、创建、打开、归档和删除；
- 普通消息、命令、编辑、停止、授权回复；
- 排队消息的提交、提升、取消和失败重试；
- primary SSE 快照接收、cursor 防倒退和本地覆盖层对账；
- 本地持久化、定时刷新和错误文案转换。

这些逻辑共享一个 Zustand store，本身没有问题。问题在于状态定义、动作实现、对账规则和辅助函数都集中在同一个文件里，文件已经超过 1,600 行。任何消息交互调整都会同时碰到会话切换、IPC 返回、SSE 更新和全局 `sending/error`，很难判断一次修改实际影响哪个会话。

最近修复已经证明风险不只是文件太长：

- 旧会话的异步请求可能清掉新会话的 `sending`；
- 普通发送和真正排队曾共用同一种本地展示状态；
- IPC 成功、SSE 延迟时，连续发送的第二条消息容易被错误分类；
- 服务端的 `pending → running` 短暂状态可能让普通消息闪入待处理队列；
- SSE 已确认成功后，迟到的 IPC 失败不能把成功重新改成失败。

因此本次工作不是简单按行数切文件，而是先把状态所有权说清楚，再按职责拆分实现。

## 目标

- 保留一个 Zustand store，保证会话切换、IPC 返回和 SSE 更新可以原子提交。
- 移除面向所有会话的全局 `sending` 和全局 `error`。
- 把异步状态归属到具体会话、具体操作或具体应用域。
- 组件通过 selector 读取“当前页面需要的状态”，不再自行拼接跨域状态。
- 把 store 拆成职责单一、依赖方向清晰的模块。
- 保持现有 renderer 导入入口稳定，避免一次性修改大量无关调用方。
- 用职责说明文档记录真实运行流程、状态位置和模块边界。
- 保持现有 daemon、IPC、SSE 和持久化协议不变。

## 非目标

- 不修改 daemon 的会话排队、steer、幂等或 cursor 语义。
- 不引入每个会话一个独立 Zustand store 或 actor runtime。
- 不让 renderer 同时维护多个 primary SSE 订阅。
- 不在本次重做会话页面视觉设计。
- 不把项目管理、Git 服务或 session service 迁出 Electron main process。
- 不为了降低行数创建只有一两个转发函数、没有明确所有权的碎片文件。

## 方案比较

### 方案一：只拆文件，保留全局状态

把现有动作机械移动到多个文件，继续共享顶层 `sending/error/sessionView`。

优点是改动小，短期容易通过测试。缺点是竞态根因不变：旧操作仍可能清理新操作状态，一个会话的失败仍可能污染另一个会话。文件变短了，但运行模型没有变清楚。

本方案不采用。

### 方案二：单一 store，加会话运行态和操作状态

保留一个 Zustand store，把应用状态、目录状态、当前导航状态和会话运行态分开；每次异步动作都有唯一 operation ID，并绑定到会话或新会话入口。

优点是：

- SSE、IPC 和切换会话仍可以在同一次 `set` 中原子对账；
- `sending/error` 可以按会话和操作隔离；
- 现有组件可以通过 selector 渐进迁移；
- 不需要引入新的生命周期框架。

缺点是 action 模块仍共享同一个 store 类型，需要严格限制依赖方向并维护统一的操作辅助函数。

本次采用此方案。

### 方案三：每个会话一个 store 或 actor

每个会话拥有独立实例，导航层只管理当前实例。

隔离最彻底，但会引入实例创建、回收、订阅转移、缓存失效和跨会话列表同步问题。当前桌面端只有一个 primary SSE，actor 数量与服务端订阅所有权也不一致，复杂度超过现阶段收益。

本方案暂不采用。

## 总体状态模型

store 逻辑上分成四层。这里的“层”表示状态所有权，不要求全部做成嵌套对象；最终字段是否嵌套由实施计划决定，但 selector 和 action 必须遵守这些边界。

### 1. 应用层

负责整个桌面 renderer 只有一份的状态：

- `loadStatus`；
- `daemonStatus`；
- 可用模型和默认模型；
- 默认 provider；
- 默认 permission mode；
- bootstrap 级错误。

应用初始化失败可以放在应用层，因为它不属于某个会话。会话发送失败不能放在这里。

### 2. 目录层

负责项目、会话目录和 Git 元数据：

- projects；
- sessions 与 archived sessions；
- workspace mode；
- selected project；
- selected project Git 状态、branch 和 branches；
- 项目级操作及项目级错误。

目录层保存“有哪些会话”，不保存“当前会话正在发送什么”。

### 3. 导航与 primary 视图层

负责当前页面指向哪里，以及 renderer 当前持有的唯一 primary 会话快照：

- `activeSessionId`；
- `sessionView`；
- 当前 primary 订阅的打开请求；
- 当前视图 cursor 和 sync 状态；
- 新会话入口使用的模型、provider 和 permission mode 选择。

`sessionView` 只代表 `activeSessionId` 的权威快照。后台会话操作不能把自己的快照写进这里，也不能调用 primary `sessions.open` 抢走订阅。

### 4. 会话运行态层

每个会话拥有自己的 renderer 本地运行态：

- 仍在进行或失败待处理的 operations；
- pending prompt submissions；
- pending prompt edit；
- queued prompt actions；
- 与该会话绑定的局部错误；
- 本地覆盖层需要的确认信息。

还需要一个 `newConversationRuntime`。创建会话前没有 session ID，创建操作先属于这里；main process 返回 session 后，再原子绑定到真实 session runtime。

运行态只保存 renderer 尚未被权威快照接管的本地事实，不复制完整 session transcript。

## 操作模型

每次异步用户操作都创建唯一 operation ID。建议使用以下判别结构：

```ts
type DesktopOperationKind =
  | "create-session"
  | "open-session"
  | "send-prompt"
  | "invoke-command"
  | "edit-prompt"
  | "promote-prompt"
  | "cancel-prompt"
  | "interrupt-run"
  | "reply-permission"
  | "project-action"

interface DesktopOperation {
  id: string
  kind: DesktopOperationKind
  phase: "pending" | "acknowledged" | "failed"
  sessionId: string | null
  projectId?: string
  startedAt: number
  finishedAt?: number
  error?: string
}
```

这只是状态契约，不要求所有操作永远保存在一个无界全局数组中。生命周期规则如下：

1. 发起操作时写入所属 runtime。
2. IPC 成功但仍需等待 SSE 时，进入 `acknowledged`。
3. SSE 已证明结果后，移除已完成操作。
4. 失败操作保留到 UI 已展示、用户重试或主动清理。
5. 不需要 SSE 确认的操作，在 IPC 完成后直接移除或保留局部失败。
6. 新会话创建成功后，操作从 `newConversationRuntime` 绑定到返回的 session ID。

任何 `finally` 都只能结束自己 operation ID 对应的状态，不能写一个全局 `sending=false`。

## `sending` 的替代方式

组件不再读取全局布尔值。通过 selector 从当前上下文推导：

- `selectNewConversationSending`：新会话入口是否有 create/send 操作进行中；
- `selectActiveSessionSending`：当前会话是否有会阻止 composer 再次提交的操作；
- `selectSessionOperationPending(sessionId, kind)`：指定会话、指定操作是否进行中；
- `selectQueuedPromptAction(sessionId, runId)`：某个排队项是否正在提升或取消；
- `selectPermissionReplyPending(sessionId, permissionId)`：某个授权请求是否正在回复。

selector 返回的是页面语义，不要求组件理解 operation 表结构。

不同操作是否互斥由 selector 明确表达。例如发送消息可以锁 composer，但取消某条排队消息只锁那一条消息，不能锁住整个应用。

## `error` 的替代方式

错误跟随最具体的所有者：

- bootstrap 失败：应用层；
- 项目选择或 Git 操作失败：目录层对应项目操作；
- 创建会话失败：`newConversationRuntime` 的 operation；
- 发送或命令失败：对应 session runtime 的 operation；
- prompt 已经有本地实体时：错误直接跟随 submission、edit 或 queued action；
- SSE 重连状态：`sessionView.syncStatus`，不伪装成用户操作失败。

UI 通过 selector 读取当前作用域错误，例如：

- `selectNewConversationError`；
- `selectActiveSessionComposerError`；
- `selectProjectOperationError(projectId)`；
- `selectQueuedPromptActionError(sessionId, runId)`。

一个错误最多有一个展示所有者，避免同一失败既出现在全局 toast，又出现在消息卡片。切换会话后，旧会话错误仍可以保留在旧 runtime，但不能显示在新会话。

## PendingPrompt 与操作状态的关系

`PendingPromptSubmission` 是尚未被 SSE 权威快照接管的消息实体，不等同于通用 operation。

它继续保存：

- 幂等 input ID；
- session ID；
- content；
- `submitting/accepted/failed`；
- `placement: transcript | queue`；
- 错误和创建时间。

`placement` 必须在点击发送时固化：

- 会话没有进行中的 run，也没有尚未被 SSE 确认的本地提交：`transcript`；
- 会话已有 pending/running run，或者已有本地 submitting/accepted submission：`queue`；
- 重试沿用原 submission 的 placement；
- 后续 SSE 不能把已有 placement 反向改写。

展示规则：

- `transcript` 本地提交不进入 `PendingPromptQueue`；
- `queue` 本地提交在 SSE 到达前立即显示；
- 失败 submission 无论 placement 都保留可见错误；
- 服务端只有一个 pending run、尚无 running run 时，最早的 pending run 是即将执行的 active candidate，不是队列；
- 同时有多个 pending run 时，只隐藏 active candidate，后续 pending runs 继续显示；
- 已有 running run 时，其他 pending runs 都是真正队列项。

这些规则必须在拆分期间保持测试覆盖，不能退回到“看到 pending 就显示队列”。

## Primary SSE 与会话切换

桌面 renderer 只有一个 primary 会话订阅。打开会话需要 request/operation 所有权：

1. 用户点击会话 B，创建 `open-session(B)` operation，并把 B 设为 active。
2. 调用 `sessions.open(B)`，main process 把 primary 订阅切到 B。
3. 只有当返回时 active session 仍是 B，且 operation ID 仍是当前打开请求，才能应用 snapshot。
4. 较老 snapshot 的 cursor 不能覆盖较新 SSE view。
5. 创建会话 A 的请求如果迟到，而用户已经选择 B，A 可以完成自己的首条 prompt，但不能调用 primary `sessions.open(A)`，也不能把 active session 改回 A。

`applySessionUpdate(view)` 必须满足：

- 只接收当前 active session 的 primary 更新；
- 只接受不早于当前 cursor 的 view；
- 只对账 view.session.id 对应的 runtime；
- SSE 已确认的操作优先于迟到的 IPC 失败；
- 不清理其他会话的 operation、submission 或 error。

## IPC 与 SSE 对账规则

IPC 表示请求是否被 daemon 接收，SSE/snapshot 表示当前权威会话状态。两者到达顺序不固定。

必须支持以下顺序：

### IPC 先到

1. operation 或 submission 标记为 acknowledged。
2. 保留本地覆盖层，不伪造 cursor。
3. SSE 包含相同 input/run/action 结果后清理覆盖层。

### SSE 先到

1. 根据稳定 ID 对账并清理本地覆盖层。
2. 随后 IPC 成功只结束对应 operation。
3. 随后 IPC 失败时，如果 SSE 已确认成功，按成功处理，不重新写失败。

### 用户在等待期间切换会话

1. 旧 operation 可以继续结束。
2. 结果只能更新旧 session runtime。
3. 新会话的 selector 不读取旧 runtime，所以不会被锁定或显示旧错误。

### 连续快速发送

1. 第一条普通发送是 transcript placement。
2. 第一条 IPC 已确认但 SSE 尚未返回时，本地 acknowledged submission 仍代表进行中工作。
3. 第二条必须分类为 queue placement，并立即显示。
4. SSE 最终按 input ID 接管两条消息，不重复、不闪回。

## 模块结构

目标目录：

```text
apps/desktop/src/renderer/src/stores/
├─ desktop-session-store.ts
└─ desktop-session/
   ├─ README.md
   ├─ types.ts
   ├─ initial-state.ts
   ├─ store.ts
   ├─ selectors.ts
   ├─ operation-state.ts
   ├─ error-state.ts
   ├─ session-view-state.ts
   ├─ session-view-actions.ts
   ├─ pending-prompt-state.ts
   ├─ bootstrap-actions.ts
   ├─ project-actions.ts
   ├─ project-details-coordinator.ts
   ├─ project-git-scheduler.ts
   ├─ session-actions.ts
   ├─ prompt-actions.ts
   ├─ queued-prompt-actions.ts
   ├─ persistence.ts
   ├─ helpers.ts
   └─ store-test-fixtures.ts（仅测试）
```

### `desktop-session-store.ts`

兼容入口。只负责从新目录导出 `useDesktopSessionStore`、公开 selector 和调用方需要的公开类型。不得重新堆积实现逻辑。

### `types.ts`

定义完整 store state、action 接口、runtime、operation、error scope 和本地覆盖实体。其他模块只能从这里引用共享 store 类型，避免相互导入具体 action 文件。

### `initial-state.ts`

创建初始状态。不得注册事件、读取 localStorage 或调用 IPC。

### `store.ts`

组合初始状态和各 action creator，创建唯一 Zustand store。负责依赖注入边界，不直接实现业务动作。

### `selectors.ts`

提供组件使用的语义 selector。负责从 active session、runtime 和 operation 推导 sending、error、pending queue 等展示状态。组件不得复制这些推导规则。

### `operation-state.ts`

提供创建、绑定、确认、失败、移除 operation 的纯函数。所有函数都按 operation ID 和所属 scope 工作。

### `error-state.ts`

提供作用域错误归属、清理和错误文本规范化。已经跟随 submission/action 的错误不在这里重复保存。

### `session-view-state.ts`

提供 cursor 比较、active session 校验、snapshot/SSE 应用和 runtime 对账入口。这里决定权威 view 是否可以接管，不发起 IPC。

### `session-view-actions.ts`

承接已接收的 SSE 快照，写入目录、导航和对应 session runtime。它调用 `session-view-state.ts` 的纯规则，不发起 IPC。

### `pending-prompt-state.ts`

提供 submission placement 分类、重试复用、SSE 确认、PendingPromptQueue 展示模型和 queued action 对账纯函数。

### Action 文件

- `bootstrap-actions.ts`：初始化、refresh bootstrap、daemon 事件挂接；
- `project-details-coordinator.ts`：项目选择与项目详情 generation 的共享所有者，供 `project-actions.ts` 和 `session-actions.ts` 注入使用；
- `project-actions.ts`：项目选择、Git 状态、branch 和项目设置；旧 choose/select/refresh/checkout/create branch 返回不得覆盖更新意图；
- `project-git-scheduler.ts`：合并短时间内重复的 Git 刷新请求，并在 store 监听解绑时取消未执行工作；
- `session-actions.ts`：新会话入口、创建、打开、fork、rename、pin、archive、delete；默认模型和权限模式使用同一总顺序写入，打开会话 inspect 共享项目详情所有权，首条 slash command 必须等待 primary open 成功；
- `prompt-actions.ts`：发送、命令、编辑、停止、授权回复；
- `queued-prompt-actions.ts`：提升和取消排队消息。

Action 文件负责调用 IPC，并使用纯状态模块更新 store。它们不得各自实现一套 operation 结束或 SSE 确认判断。

### `persistence.ts`

封装 active session、project selection 等 renderer 持久化读写。读取失败必须有安全默认值，不能阻止应用启动。

### `helpers.ts`

只放真正跨模块、无状态、没有更明确归属的工具，例如 session title 格式化和稳定排序。错误处理属于 `error-state.ts`，cursor 处理属于 `session-view-state.ts`，不能都塞回 helpers。

### `store-test-fixtures.ts`

仅供测试构造稳定 session、bootstrap 数据和 renderer mock，不参与生产代码依赖方向。

## 依赖方向

建议依赖方向如下：

```text
types
  ↑
initial-state / operation-state / error-state / session-view-state / pending-prompt-state / persistence / project-git-scheduler
  ↑
bootstrap-actions / project-actions / session-actions / prompt-actions / queued-prompt-actions / session-view-actions
  ↑
store
  ↑
desktop-session-store compatibility entry / selectors / components
```

纯状态模块不得导入 action 模块或 store 单例。Action 模块通过统一的 `set/get` 上下文工作，不直接导入并调用另一个 action 模块的内部函数；需要复用的状态规则下沉到对应纯状态模块。

## 组件接入规则

- 保留 `useDesktopSessionStore` 作为唯一 hook 入口。
- 组件优先导入命名 selector，避免大段匿名 selector 重复业务判断。
- 组件可以读取权威 view 的展示数据，但不能自行判断 operation 是否属于当前会话。
- `conversation-page.tsx` 不再读取全局 `sending/error`。
- 每个队列项、授权项和项目操作读取自己的局部 pending/error。
- selector 应尽量返回稳定引用，避免 operation 表的无关变化导致整个页面重渲染。

## 职责说明文档

实施时必须新增：

`apps/desktop/src/renderer/src/stores/desktop-session/README.md`

README 面向后续维护者，至少包含：

1. 这个目录解决什么问题、不负责什么；
2. 四层状态的实际含义和存放位置；
3. 每个文件的职责表；
4. 新会话创建、普通发送、排队发送、会话切换和 SSE 对账流程；
5. primary SSE 的唯一所有权规则；
6. operation/error 的创建、确认、失败和清理生命周期；
7. 新增 action 或状态时应该放到哪个模块的检查清单；
8. 本设计中的不可破坏约束。

README 必须描述真实代码，不复制过期计划。如果最终文件名在实施中有合理调整，README 和本规格的映射要明确说明。

## 测试策略

测试也按职责拆分，避免继续维护一个同样巨大的测试文件。建议结构：

```text
desktop-session/
├─ operation-state.test.ts
├─ session-view-state.test.ts
├─ pending-prompt-state.test.ts
├─ prompt-actions.test.ts
├─ session-actions.test.ts
└─ store.integration.test.ts
```

### 纯状态测试

- operation ID 所有权与旧操作不能清理新操作；
- error scope 隔离；
- cursor 不倒退；
- submission placement 分类；
- pending active candidate 与真实队列区分；
- SSE 对账只清理同会话同实体。

### Action 测试

- IPC 参数和稳定幂等 ID；
- IPC 成功、失败和重试；
- 创建会话后 operation 绑定；
- 后台会话请求不能调用 primary open；
- prompt、command、edit、interrupt 和 permission 的局部锁定范围。

### 集成竞态测试

- IPC 先于 SSE；
- SSE 先于 IPC；
- SSE 已成功、IPC 丢响应；
- 打开 A 后立即打开 B，A 的迟到 snapshot 不覆盖 B；
- 创建 A 期间用户打开 B，A 不抢 primary 订阅；
- renderer 监听全部解绑期间错过终态后，重新从 0→1 挂接会补 active session snapshot，且第二个引用不重复 open；
- 默认模型/权限使用同一写入队列，项目 Git 请求由共享 coordinator 判定最新意图；完整 bootstrap 响应或旧详情均不能覆盖另一个字段或入口的更新；
- resync 不调用用户导航 `openSession`，在途 primary open 继续拥有其成功/失败和首条 slash command 的结果；
- 后台首条命令成功后回收 create/invoke operation，命令失败只保留最新可见项；
- 旧会话发送结束不清理新会话 sending；
- 普通消息不闪入 PendingPromptQueue；
- 第一条未被 SSE 确认时快速发送第二条，第二条立即排队；
- promote/cancel 确认后旧 SSE 不让队列项闪回；
- 切换会话后错误不串页。

现有测试先迁移再删除，任何测试不得因为拆文件而失去原断言。

## 实施顺序

具体逐文件操作由后续 implementation plan 定义，但总体顺序固定：

1. 建立新目录、类型、初始状态和兼容入口；
2. 提取纯 persistence/helper，不改变行为；
3. 建立 operation 和 scoped error 状态，先用测试固定生命周期；
4. 提取 session view 与 pending prompt 对账纯函数；
5. 迁移 bootstrap 和 project actions；
6. 迁移 session actions，并保护 primary open 所有权；
7. 迁移 prompt 与 queued prompt actions；
8. 把组件切到 selector，移除全局 `sending/error`；
9. 拆分测试文件并运行完整竞态回归；
10. 新增并校对目录 README；
11. 删除旧实现残留，只保留兼容导出入口。

每个阶段都应保持可编译和测试可运行，不允许先把所有代码移动后再一次性修类型。

## 不可破坏约束

1. 后台会话不能调用 primary `sessions.open`。
2. 旧 operation 不能结束新 operation 的 loading/sending。
3. SSE 已确认的成功不能被迟到的 IPC 失败反转。
4. 一个会话的错误不能显示到另一个会话。
5. active view 只能接受同一 session 且 cursor 不更旧的更新。
6. 普通发送不能短暂出现在 PendingPromptQueue。
7. 真正排队的消息在 SSE 到达前必须有即时反馈。
8. 快速连续发送时，未被 SSE 确认的本地提交也算进行中工作。
9. 组件使用 selector 获取操作语义，不能自己遍历 operation 表拼装业务规则。
10. renderer 不生成假的服务端 cursor 或伪造权威 transcript。
11. operation、submission 和 queued action 必须使用稳定 ID 对账。
12. 完成的 operation 必须清理，失败状态必须有明确的用户可见所有者，不能无界积累。

## 验收标准

- `desktop-session-store.ts` 只保留兼容导出，不再包含业务实现。
- `desktop-session/README.md` 存在并与实际代码一致。
- 不再存在供所有会话共用的 `sending` 和 `error` 状态。
- 当前页面、每个会话和每个局部操作都能独立读取 pending/error。
- 组件不复制 session/operation 所有权判断。
- 原有桌面端行为测试全部迁移并通过。
- 本规格列出的竞态场景都有自动化测试。
- Desktop 完整测试、Web TypeScript 检查、相关 lint 和仓库类型检查通过。
- 不改 daemon/IPC/SSE 公共协议。
- 不覆盖或提交用户工作区中与本任务无关的修改。
