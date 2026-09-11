# 输入框能力闭环实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将输入框的 `/`、`$`、`@`、`+`、附件和系统状态统一为可发现、可执行、可恢复的能力入口。

**架构：** `@` 与 `+` 共享一个 Context Picker；`/` 和 `$` 保持独立 Picker。所有选择结果使用新的结构化 composer item 传递，服务端负责解析、校验和执行；展示型系统状态使用 metadata presentation，不进入模型上下文。本次不做旧数据兼容层。

**技术栈：** React、Lexical、TypeScript、Vitest、现有 Desktop IPC、SessionStore、AgentEventBus。

---

## 文件与职责

- 修改 `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/composer.tsx`：统一 `+` 菜单入口，保留附件回调。
- 修改 `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/rich-prompt-input.tsx`：接入 `@` Context Picker 和结构化选择结果。
- 修改 `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/composer-picker.tsx`：支持分类、搜索和统一键盘交互。
- 修改 `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/composer-trigger.ts`：定义 `/`、`$`、`@` 的边界和 IME 行为。
- 修改 `apps/desktop/src/shared/session-types.ts`：补充上下文项和能力状态类型。
- 修改 `apps/desktop/src/main` 与 `apps/desktop/src/preload` 相关 IPC：提供上下文目录和选择动作所需数据。
- 修改 `packages/client/src/commands/session-commands.ts`：复用已有计划模式和命令行为。
- 修改 `packages/server/src/application/session`：校验并执行上下文项、目标和模式变更。
- 修改 `packages/server/src/application/agent/daemon-agent-event-projector.ts`：投影能力状态和系统 presentation 消息。
- 修改 `packages/server/src/application/agent/agent-transcript.ts`：排除 presentation-only 消息。
- 修改 `apps/desktop/src/renderer/src/components/desktop/conversation-page/message`：展示能力执行和压缩状态。
- 新增/修改对应 `__test__` 文件：覆盖入口、选择、执行、失败、恢复和回归行为。

## 任务 1：冻结新协议和现状回归

**交付物：** 明确全新的结构化上下文项协议，并锁定附件、`/`、`$` 当前行为；不实现迁移或双读。

- [ ] 编写失败测试：验证 `@`/`+` 上下文项类型、协议不匹配报错和附件拖拽/粘贴不变。
- [ ] 运行相关 Desktop composer 测试，确认新断言失败。
- [ ] 在 `session-types.ts` 定义 `DesktopContextItem`、来源、选择动作和状态字段。
- [ ] 为协议不匹配增加明确错误返回，不增加旧 metadata 兼容解析。
- [ ] 运行 composer、附件和 transcript 测试。
- [ ] Commit：`feat: define composer context item protocol`

## 任务 2：统一 `@` 与 `+` Context Picker

**交付物：** 两个入口打开同一个面板；文件和历史对话使用统一上下文模型，文件和文件夹选择复用现有附件上传链路。

- [ ] 编写测试：键入 `@` 与点击 `+` 使用同一 Picker；选择文件调用现有 `onPickFiles`；拖拽/粘贴回归通过。
- [ ] 运行测试确认失败。
- [ ] 抽取共享 Context Picker 数据和分类渲染，不复制附件上传逻辑。
- [ ] 将历史定义为参考对话选择，不切换当前会话；目标和站点不在本期范围内。
- [ ] 将 `+` 从直接文件选择改为打开 Context Picker，文件项再调用 `onPickFiles`。
- [ ] 让 `@` 使用同一 picker 状态、搜索、高亮、Enter/Tab/Esc 行为。
- [ ] 运行相关测试并检查中文输入法组合态。
- [ ] Commit：`feat: unify at and plus context picker`

## 任务 3：接入计划模式并完善 Slash/Skill

**交付物：** 计划模式在 Context Picker 中复用现有 `plan` 状态；命令和 Skill 规则稳定。

- [ ] 编写测试：选择计划模式调用既有模式切换；首字符 `/` 显示完整命令；正文中间 `/` 过滤空输入命令；`$` 选择 Skill。
- [ ] 运行测试确认失败。
- [ ] 将计划模式映射到现有 permission mode，不创建第二套状态。
- [ ] 保持 `/compact`、`/plan` 等命令的执行语义不变。
- [ ] 修正 IME composition 期间 Enter 的处理。
- [ ] 运行 composer 和 session command 测试。
- [ ] Commit：`feat: align plan slash and skill composer actions`

## 任务 4：能力执行状态闭环

**交付物：** 能力从选择到成功、失败、取消都有服务端状态和客户端反馈。

- [ ] 编写服务端测试：能力不存在、权限不足、参数错误、超时、取消分别返回稳定错误码。
- [ ] 编写客户端测试：执行中、成功、失败、取消状态可见并可恢复。
- [ ] 在服务端增加结构化能力校验和执行入口。
- [ ] 通过 AgentEventBus 发布 `capability_status` 事件。
- [ ] 在 projector 中写入事件和 presentation-only 消息。
- [ ] 在消息组件中展示执行状态，不把状态消息送入模型上下文。
- [ ] 运行 server、agent-runtime、desktop 相关测试。
- [ ] Commit：`feat: add composer capability execution lifecycle`

## 任务 5：历史对话引用

**交付物：** 可以从 `@` / `+` 面板搜索历史对话，并将选中的对话作为受限只读参考上下文。

- [ ] 编写测试：按名称搜索会话、选择会话生成引用、当前会话不能被重复注入。
- [ ] 增加只读会话搜索接口，返回稳定 ID、标题和摘要。
- [ ] 发送时由服务端按 ID 读取并裁剪参考内容，设置 token 上限。
- [ ] 校验会话访问范围，禁止通过客户端伪造内容或跨权限读取。
- [ ] 运行 session、server、desktop 历史引用测试。
- [ ] Commit：`feat: add read-only conversation context`

## 任务 6：压缩、恢复和发布验收

**交付物：** 自动压缩和 `/compact` 状态展示一致，历史恢复和新协议测试完整。

- [ ] 编写测试：显示“正在压缩上下文”“已压缩上下文”“上下文压缩失败”。
- [ ] 验证自动压缩和手动 `/compact` 都发布相同 presentation 结构。
- [ ] 验证 presentation-only 消息不会进入 Agent transcript。
- [ ] 验证失效 Skill、缺失上下文项返回明确错误；不实现旧消息兼容层。
- [ ] 运行全部相关测试：composer、attachment、session、server projector、compact。
- [ ] 检查 git diff，保留用户已有未提交修改。
- [ ] Commit：`test: verify composer capabilities end to end`
- [ ] 推送并记录验证结果。

## 验收门槛

- `@` 和 `+` 打开同一个 Context Picker。
- 文件选择、拖拽、粘贴附件全部保持可用。
- `/`、`$`、计划模式行为符合既有语义和 Codex 对齐规则。
- 目标能力有真实生命周期，不以静态菜单冒充完成。
- 能力执行、错误、取消、刷新恢复都有证据。
- 自动压缩和 `/compact` 都有 metadata 状态消息。
- 相关测试通过；全量测试若受环境限制，必须明确记录原因。
