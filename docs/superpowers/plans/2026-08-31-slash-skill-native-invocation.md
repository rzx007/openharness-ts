# Slash Skill 原生调用实现计划

> 状态：已按审核结论在 `main` 实施；最终验证结果以任务交付说明为准。

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** Slash Skill 通过普通 prompt payload 携带结构化 metadata，并明确要求 agent 使用现有 `Skill` 工具加载技能；消息列表只展示 Skill 胶囊和用户任务。

**架构：** `GET /commands` 继续提供可调用 Skill 目录，桌面端把选中的 Skill 转成普通 `sendPrompt` 请求。durable input 保存原始任务和 `skillInvocation` metadata，run executor 只把本轮 agent 输入改写为“先调用 Skill 工具”，实际正文和目录位置由现有 `Skill` 工具从 registry 读取。transcript 将调用摘要放进用户文本 part metadata，桌面消息组件据此显示胶囊。

**技术栈：** TypeScript、Vitest、React、Electron IPC、Hono、OpenHarness session runtime。

---

## 文件结构

- `packages/client/src/types/index.ts`：定义共享的 Skill invocation metadata；删除 command POST 客户端类型。
- `packages/client/src/transport/http-client.ts`：删除 `invokeCommand()`，保留普通 `admitPrompt()`。
- `packages/client/src/transport/__test__/http-client.test.ts`：验证普通 prompt payload；移除 command POST 期望。
- `packages/server/src/commands/commands.ts`：command catalog 只保留发现能力，删除 `expand()` 契约。
- `packages/server/src/commands/default-command-catalog.ts`：删除 Skill 正文展开，只列目录。
- `packages/server/src/http/routes/session.ts`：删除 `POST /:sessionId/commands`。
- `packages/server/src/http/routes/__test__/routes.test.ts`、`packages/server/src/http/__test__/http.test.ts`：删除旧路由测试，保留 GET catalog 测试。
- `packages/server/src/application/session/skill-invocation.ts`：解析 metadata 并构造本轮 agent 输入，职责独立且可单测。
- `packages/server/src/application/session/__test__/skill-invocation.test.ts`：覆盖 Skill 输入转换和非法 metadata 回退。
- `packages/server/src/application/session/session-run-executor.ts`：调用 Skill 输入转换 helper，不读取 Skill 正文。
- `packages/server/src/application/session/__test__/session-run-executor.test.ts`：验证实际提交给 agent 的内容。
- `packages/tools/src/meta/skill.ts`：原生 `Skill` 工具返回正文、可信文件位置和根目录。
- `packages/tools/src/__test__/registry.test.ts` 或相邻 Skill 测试：验证 Skill 工具的真实输出。
- `packages/server/src/application/session/transcript-projection.ts`：把 `skillInvocation` 摘要复制到用户 text part metadata。
- `packages/server/src/application/session/__test__/transcript-projection.test.ts`：验证原始任务和 invocation metadata 的投影。
- `apps/desktop/src/shared/session-types.ts`：让 `SendDesktopPromptInput` 接收 Skill invocation metadata，并删除 `InvokeDesktopCommandInput`。
- `apps/desktop/src/shared/desktop-api-contract.ts`、`apps/desktop/src/preload/desktop-api.ts`、`apps/desktop/src/main/features/session/ipc.ts`：删除旧 invokeCommand IPC。
- `apps/desktop/src/main/features/session/session-service.ts`：普通 prompt 提交时转发 Skill metadata；删除旧 command 调用。
- `apps/desktop/src/main/features/session/session-service.test.ts`：验证 metadata 转发。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer-skill-commands.ts`：从 Slash draft 生成任务与 metadata，并按来源排序。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer-skill-commands.test.ts`：验证 payload 解析和来源排序。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/conversation-page.tsx`：提交 Skill invocation，而不是 command line。
- `apps/desktop/src/renderer/src/stores/desktop-session/types.ts`：将 `commandLine` 替换为 `skillInvocation`。
- `apps/desktop/src/renderer/src/stores/desktop-session/prompt-actions.ts`、`session-actions.ts`：新会话和已有会话都走 `sendPrompt`。
- 对应 store 测试：验证 Skill 消息走普通 prompt，且附件策略与普通消息一致。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/message-block.tsx`：显示 Skill 胶囊。
- 相邻组件测试：验证胶囊、用户任务和普通消息行为。

### 任务 1：普通消息 Skill metadata 与桌面提交

- [ ] **步骤 1：编写失败测试**

在 composer 和 store 测试中断言 `/archify 画一下系统架构` 被解析为：

```ts
{
  content: "画一下系统架构",
  skillInvocation: {
    name: "archify",
    commandName: "archify",
    source: "user",
    invocationSource: "slash",
  },
}
```

并断言 `sendPrompt()` 收到 metadata，而 `invokeCommand()` 不再参与 Skill 提交。

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
pnpm --filter @openharness/desktop test -- composer-skill-commands.test.ts prompt-actions.test.ts session-actions.test.ts session-service.test.ts
```

预期：新 API 或 metadata 断言失败，因为当前实现仍调用 `invokeCommand()`。

- [ ] **步骤 3：实现最少代码**

新增 `SkillInvocationMetadata` 和 `parseSkillCommandInvocation()`；让现有会话、新会话和 main process 的 `sendPrompt()` 原样转发该 metadata。

- [ ] **步骤 4：运行测试验证通过**

重复步骤 2 的命令，预期相关测试全部通过。

### 任务 2：本轮 agent 输入转换

- [ ] **步骤 1：编写失败测试**

为纯函数和 run executor 增加测试：合法 metadata 生成明确的 `Skill` 工具调用指令；无 metadata 或非法 name 保持原 content。

期望文本：

```text
请先使用 Skill 工具加载 "archify" 技能，然后按该技能要求完成下面的任务：

画一下系统架构
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm --filter @openharness/server test -- skill-invocation.test.ts session-run-executor.test.ts
```

预期：helper 不存在，executor 仍把原 content 直接提交给 agent。

- [ ] **步骤 3：实现最少代码**

创建 `skill-invocation.ts`，只读取 `metadata.skillInvocation.name` 并构造文本；`session-run-executor.ts` 在附件路由完成后、调用 `agent.submitMessage()` 前应用转换。

- [ ] **步骤 4：运行测试验证通过**

重复步骤 2 的命令，预期全部通过。

### 任务 3：原生 Skill 工具返回位置上下文

- [ ] **步骤 1：编写失败测试**

用真实 `SkillRegistry` 注册带 `path` 的 skill，执行 `Skill` 工具后断言结果包含：skill 名称、规范化的 Skill file、父目录 Skill root、相对路径解析说明和正文。

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm --filter @openharness/tools test -- registry.test.ts
```

预期：当前输出只有正文，缺少 file/root。

- [ ] **步骤 3：实现最少代码**

在 `skill.ts` 中用 registry 返回的 `skill.path` 和 `node:path.dirname()` 格式化结果；不存在 path 时仍返回正文和可用提示，不相信工具 input 中的路径。

- [ ] **步骤 4：运行测试验证通过**

重复步骤 2 的命令，预期全部通过。

### 任务 4：Transcript metadata 与 Skill 胶囊

- [ ] **步骤 1：编写失败测试**

投影测试断言用户 text part 保留原始任务，并携带 `skillInvocation` 摘要。桌面组件测试断言 Skill 名称、来源标签和任务可见，正文/绝对路径不可见；普通消息不显示胶囊。

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm --filter @openharness/server test -- transcript-projection.test.ts
pnpm --filter @openharness/desktop test -- message-block.test.tsx
```

预期：part metadata 为空，UI 没有 Skill 胶囊。

- [ ] **步骤 3：实现最少代码**

`projectUserInput()` 把合法 invocation 摘要复制到 text part metadata；`MessageBlock` 从 part metadata 读取并渲染紧凑胶囊，编辑和复制仍使用 `messageTextContent(parts)`。

- [ ] **步骤 4：运行测试验证通过**

重复步骤 2 的命令，预期全部通过。

### 任务 5：删除旧 command POST 链路

- [ ] **步骤 1：更新契约测试**

客户端传输测试不再期望 `/sessions/:id/commands`；server command catalog 只测试 `list()`，HTTP 路由不再接受 command POST。

- [ ] **步骤 2：运行测试验证旧实现冲突**

```bash
pnpm --filter @openharness/client test -- http-client.test.ts
pnpm --filter @openharness/server test -- commands.test.ts routes.test.ts
```

预期：类型或行为仍暴露 `expand()` / `invokeCommand()`。

- [ ] **步骤 3：删除生产代码**

删除 `InvokeClientCommandInput`、`InvokeCommandResponse`、`HttpClient.invokeCommand()`、`CommandCatalogProvider.expand()`、默认 catalog 的 `expand()`、session command POST 路由，以及桌面 IPC 的 `invokeCommand`。

- [ ] **步骤 4：运行测试验证通过**

重复步骤 2 的命令，预期全部通过。

### 任务 6：完整验证

- [ ] **步骤 1：运行相关包测试**

```bash
pnpm --filter @openharness/client test
pnpm --filter @openharness/tools test
pnpm --filter @openharness/server test
pnpm --filter @openharness/desktop test
```

- [ ] **步骤 2：运行类型检查**

```bash
pnpm --filter @openharness/client check-types
pnpm --filter @openharness/tools check-types
pnpm --filter @openharness/server check-types
pnpm --filter @openharness/desktop typecheck
```

- [ ] **步骤 3：检查差异和遗留引用**

```bash
rg -n "invokeCommand|InvokeClientCommandInput|ExpandCommandResult|\.expand\(" packages apps/desktop
git diff --check
git status --short
```

预期：没有旧 Skill command POST 链路引用；diff 没有空白错误；只包含本功能和用户原有改动。
