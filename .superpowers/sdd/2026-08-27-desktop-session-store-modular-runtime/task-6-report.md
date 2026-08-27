# 任务 6 实现报告：以会话 selector 驱动界面状态

## 范围

- 新增纯 `desktop-session` selector，并以 active session、new conversation、session 和 project scope 读取运行态。
- conversation page、composer 队列、路由和布局改为使用命名 selector；已有会话与新会话的发送状态彼此独立。
- 删除顶层 `sending`、`sendingOperationId`、`openingSession`、`error`、pending/queued prompt 字段、`clearError` 及全部兼容镜像写入。
- 将旧 `desktop-session-store.test.ts` fixture 和断言迁移为 `newConversationRuntime`、`sessionRuntimes` 与 selector 语义；没有执行任务 7 的测试拆分或 store 入口重组。

## TDD 记录

### RED

1. 先新增 `selectors.test.ts` 并运行。`selectors.ts` 尚不存在，Vitest 以模块缺失失败。
2. 删除旧顶层字段后运行旧 store 测试。11 个失败均来自旧 fixture 或旧顶层状态断言，随后迁移为 runtime 和 selector 断言。
3. 审查发现同 kind、不同 target 的失败 operation 会累积。新增回归要求重试同 kind 时清理旧的失败项；修复前 `edit-old` 仍留在 runtime，测试按预期失败。

### GREEN

- selector 只从指定 session/new conversation/project runtime 读取状态，使用稳定的空 runtime，不在读路径分配对象。
- 页面仅在已有会话读取 active-session sending；新空白会话读取 new-conversation sending，因此后台会话不会污染当前 UI，普通发送也不会凭全局状态闪现队列。
- 失败错误选择保持最具体 scope；启动同一 kind 的新 operation 会清理该 runtime 中旧的失败 operation，保留其他 kind 和失败的可重试实体，限制错误累计。

## 审查

- 定向只读审查初始发现 1 个 Important：不同 target 的同 kind 失败 operation 未被清理。
- 已以对应 RED/GREEN 回归修复；没有 Critical 或其他遗留发现。

## 验证

- selector 初始 RED 后 GREEN：5/5 通过。
- 旧 fixture 迁移后任务聚焦测试：75/75 通过。
- 审查修复的 `operation-state.test.ts` RED 后 GREEN：5/5 通过。
- Desktop 全量 Vitest：34 个测试文件、207 个测试全部通过。
- Web TypeScript：`tsc --noEmit -p tsconfig.web.json --composite false --pretty false` 通过。
- 变更文件 ESLint 通过；`git diff --check` 通过。
- 生产代码旧顶层状态/`clearError`/兼容镜像静态扫描无匹配。

## 提交

实现提交：`refactor(desktop): 以会话 selector 驱动界面状态`（提交号见 Git history）。

## 审查修复第 1 轮：scoped error 的 renderer owner

### RED

1. 新增组件级回归时，`scoped-operation-errors` owner 不存在；Vitest 以模块缺失失败。
2. 最小 Alert owner 接入后，`open-session`、`interrupt-run`、`reply-permission` operation 仍未被会话错误 selector 选择，且 failed prompt submission 会在 composer 和实体内联 UI 重复显示；定向测试 6 项按预期失败。
3. 初次复审发现 app-scoped `initialize` / `choose-project` 仅在新对话分支展示。它们可从已有会话的全局入口和 settings/plugins/scheduled 首次加载触发，因此新增 app owner selector 回归；实现前以 selector 缺失失败。

### GREEN

- active session composer 仅展示当前 runtime 的 open、command、edit、interrupt、permission operation failure；new conversation 仅展示 create failure；selected project 仅展示自己的 project operation failure。
- 普通 prompt submission 与 queued action 保持 `PendingPromptQueue` 的既有内联错误 owner，不进入 composer selector，避免重复。
- app-scoped initialize / choose-project failure 由根路由唯一常驻 Alert 展示，覆盖主、设置、插件和已安排入口；新对话页面不再重复展示 app error。
- 复审第二轮为 0 Critical / 0 Important / 0 Minor。

### 本轮验证

- 严格 RED/GREEN 聚焦 Vitest：`scoped-operation-errors.test.ts` 与 `selectors.test.ts` 最终 17/17 通过。
- Desktop 全量 Vitest：35 个测试文件、219 个测试全部通过。
- Web TypeScript、变更文件 ESLint、`git diff --check` 通过。

## 审查修复第 2 轮：归档会话下的 selected project owner

### RED

- 真实 `MainLayout` 集成回归构造 active archived session 与 selected project failure。修复前 project Alert 仍只在 `ConversationPane` 的非归档 composer 分支，测试 4/4 失败：归档会话无提示、活跃/新会话没有布局 owner、切换项目不能渲染目标错误。

### GREEN

- selected project operation error 上提到与 Sidebar 同生命周期的 `MainLayout`，成为 `_main` 工作区中唯一 owner。
- `ConversationPane` 和 `NewConversationStart` 已移除 project selector、prop 与 Alert，避免 active/new 页面重复；app scope 继续只由根路由 owner 展示。
- selector 仍按 `selectedProject.id` 读取 bucket，切换项目不会显示旧项目错误。
- 复审为 0 Critical / 0 Important / 0 Minor。

### 本轮验证

- 严格 RED 后 GREEN：真实 MainLayout 集成回归 4/4 通过，覆盖归档、活跃、新会话单一展示和项目切换隔离。
- 相关 selector / scoped error / layout 测试：21/21 通过。
- Desktop 全量 Vitest：36 个测试文件、223 个测试全部通过。
- Web TypeScript、变更文件 ESLint、`git diff --check` 通过。

## 审查修复第 3 轮：MainLayout 集成测试真实性

### RED

- 原测试将 `Sidebar`、`ConversationPane` 以及 router 的 `Outlet` 替换为空组件，不能证明三者在同一生产布局树中共同存在。
- 改造后 router stub 仅承担路由边界职责，并读取 `MainLayoutContext` 挂载真实 workspace；真实 `Sidebar` 与 `ConversationPane` 全部渲染。为验证回归保护，临时移除 `MainLayout` 的 selected-project Alert owner，归档、活跃、新会话和切换项目四项断言均按预期失败（4/4）。

### GREEN

- 集成测试保留真实 `MainLayout`、`Sidebar` 和 `ConversationPane`；只 mock router、面板实现、窗口 chrome、快捷键、utility panel 与主题/store 等外部或重型依赖。
- 使用完整状态 fixture 覆盖 archived、active、new conversation：每一棵真实树中 selected-project error 都只出现一次。归档断言同时验证只读提示，活跃/新建分别验证真实会话标题与 new conversation composer，三种场景都验证真实 Sidebar 内容。
- 切换 `selectedProject` 时，旧项目 bucket 不显示、当前项目 bucket 显示；生产逻辑没有改变。

### 本轮验证

- 真实组合的受控 RED 后 GREEN：`main-layout-project-operation-error.test.ts` 4/4 通过。
- 相关 selector/error/layout 测试：10/10 通过。
- Desktop 全量 Vitest：36 个测试文件、223 个测试全部通过。
- Web TypeScript 与变更文件 ESLint 通过。
- `git diff --check` 通过。

## 审查修复第 4 轮：项目切换的真实订阅回归

### RED

- 原切换用例在服务端一次性渲染最终的 selected project，store hook 也是同步 fixture；它没有经历项目 A 到 B 的真实 Zustand 订阅与重新渲染。
- 将新客户端测试中 `MainLayout` 的 selected-project Alert owner 临时移除后，归档、活跃、新会话和 A 到 B 切换的四项断言均失败：初始 A error 与切换后的 B error 都无法从真实布局树找到。

### GREEN

- Desktop 测试开发依赖新增 `jsdom`，以客户端 React root 挂载同一棵真实 `MainLayout`、`Sidebar` 和 `ConversationPane` 树。
- store module 仅替换 Electron desktop event 绑定，`useDesktopSessionStore` 保持生产 Zustand hook；测试使用 `act` 调用 `setState`，在同一挂载实例中从 selected project A 切到 B。
- 回归断言初始只显示 A error，状态更新后 A 消失、B 显示且全树只有一个。归档、活跃和新会话仍覆盖 selected-project owner 的单一展示。

### 本轮验证

- 受控 RED 后 GREEN：客户端真实布局集成回归 4/4 通过。
- Desktop 全量 Vitest：36 个测试文件、223 个测试全部通过。
- Web TypeScript、变更测试文件 ESLint、`package.json` Prettier 与 `git diff --check` 均通过。
- 提交钩子的全仓 `turbo check-types`：57/57 task 成功；仅输出仓库既有的 Turbo output 配置警告。
