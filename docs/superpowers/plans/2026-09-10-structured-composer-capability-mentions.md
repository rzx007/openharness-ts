# 结构化输入框与多能力引用实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 Desktop 输入框从“字符串开头的单个 Skill 命令”升级为有序的 `text | skill | mention` 文档，支持通过动态 `/` 菜单或 `$` 菜单插入多个无胶囊 Skill 引用。

**架构：** 协议层定义结构化输入 item 和派生纯文本规则；Session store 持久化 `items_json`，附件继续走独立关系；Desktop 使用 Lexical 文档作为编辑期事实来源。Skill catalog 直接提供 Codex 风格的 `name + path`，服务端验证 path 属于当前 cwd catalog 后，通过扩展后的 Skill 工具按路径精确加载。

**技术栈：** TypeScript、React、Lexical、Zustand、Electron IPC、Drizzle/SQLite、Vitest、Tailwind CSS。

---

## 文件结构

### 新建

- `packages/protocol/src/session-input-items.ts`：结构化输入类型、上限校验、规范纯文本生成。
- `packages/protocol/src/session-input-items.test.ts`：item 校验和文本生成测试。
- `packages/services/src/session-runtime/migrations/0017_structured_input_items.sql`：增加 `items_json`，旧记录保持不可读取状态。
- `apps/desktop/src/renderer/src/stores/desktop-session/composer-document.ts`：Desktop 文档类型、规范化与纯文本 codec。
- `apps/desktop/src/renderer/src/stores/desktop-session/composer-document.test.ts`：草稿文档 codec 测试。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer-trigger.ts`：基于光标的 `/`、`$` token 识别。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer-trigger.test.ts`：中英文边界、URL、转义和光标范围测试。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer-picker.tsx`：共享菜单渲染与键盘导航。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer-picker.test.tsx`：首字符 `/`、inline `/`、`$` 的动态数据源测试。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/skill-mention-node.tsx`：无胶囊的 Lexical Skill 原子节点。

### 修改

- `packages/protocol/src/session.ts`、`packages/protocol/src/index.ts`：Session input 使用 `items`，删除单数 `SkillInvocationMetadata`。
- `packages/server/src/commands/commands.ts`、`packages/server/src/commands/default-command-catalog.ts`：Skill catalog entry 携带 path；命令元数据增加 composer 行为。
- `packages/skills/src/index.ts`：提供按规范路径解析当前 registry winner 的方法。
- `packages/tools/src/meta/skill.ts`：Skill 工具接受可选 path 并做 catalog 校验。
- `packages/services/src/session-runtime/schema.ts`、`packages/services/src/session-runtime/store.ts`、`packages/services/src/session-runtime/event-registry.ts`：持久化 items，拒绝旧输入事件。
- `packages/server/src/application/session/session-run-executor.ts`、`packages/server/src/application/agent/daemon-agent-event-projector.ts`：集中展开多个 Skill。
- `packages/server/src/application/session/skill-invocation.ts`：改为结构化输入展开模块，完成后更名为 `session-input-materializer.ts`。
- `apps/desktop/src/shared/session-types.ts`、`apps/desktop/src/shared/ipc-channels.ts`：Desktop IPC 传递 items 和命令动作。
- `apps/desktop/src/main/features/session/session-service.ts`、`apps/desktop/src/main/features/session/ipc.ts`：转发 items，并执行已支持的首字符 slash 命令。
- `apps/desktop/src/renderer/src/stores/desktop-session/composer-draft-state.ts`：草稿保存 document，而非单独 text。
- `apps/desktop/src/renderer/src/stores/desktop-session/types.ts`、`prompt-actions.ts`、`session-actions.ts`：pending、queue、steer、retry、edit 全部保留 items。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/rich-prompt-input.tsx`：Lexical state 与 ComposerDocument 双向同步。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer.tsx`、`conversation-page.tsx`：接入触发器、动态菜单和结构化提交。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/message-block.tsx`、`optimistic-transcript.ts`：从 items 渲染多个行内 Skill。
- 删除 `skill-command-pill-node.tsx`；`composer-skill-commands.ts` 只保留 catalog 映射，或被新的 picker model 取代。

---

### 任务 1：建立结构化 Session 输入契约

**文件：**
- 创建：`packages/protocol/src/session-input-items.ts`
- 创建：`packages/protocol/src/session-input-items.test.ts`
- 修改：`packages/protocol/src/session.ts`
- 修改：`packages/protocol/src/index.ts`

- [ ] **步骤 1：编写失败测试，锁定 item、上限和规范文本**

```ts
import { describe, expect, it } from "vitest"
import {
  normalizeSessionUserInputItems,
  sessionUserInputText,
  validateSessionUserInputItems,
} from "./session-input-items.js"

describe("session input items", () => {
  it("merges adjacent text and preserves skill order", () => {
    const items = normalizeSessionUserInputItems([
      { type: "text", text: "使用 " },
      { type: "text", text: "这个 " },
      { type: "skill", name: "writing-plans", path: "D:/skills/writing-plans/SKILL.md", displayName: "Writing Plans" },
      { type: "text", text: " 写计划" },
    ])
    expect(items).toEqual([
      { type: "text", text: "使用 这个 " },
      { type: "skill", name: "writing-plans", path: "D:/skills/writing-plans/SKILL.md", displayName: "Writing Plans" },
      { type: "text", text: " 写计划" },
    ])
    expect(sessionUserInputText(items)).toBe("使用 这个 $writing-plans 写计划")
  })

  it("rejects more than 32 skill items", () => {
    expect(() => validateSessionUserInputItems(
      Array.from({ length: 33 }, (_, index) => ({ type: "skill" as const, name: `s${index}`, path: `D:/s${index}/SKILL.md` }))
    )).toThrowError(/skill_item_limit_exceeded/)
  })
})
```

- [ ] **步骤 2：运行协议测试并确认因模块或导出不存在而失败**

运行：`pnpm --filter @openharness/protocol test -- session-input-items.test.ts`

预期：FAIL，提示找不到 `session-input-items.js` 或所需导出。

- [ ] **步骤 3：实现最小类型、规范化和校验**

```ts
export const SESSION_INPUT_LIMITS = {
  maxItems: 256,
  maxSkills: 32,
  maxTextBytes: 1024 * 1024,
  maxNameChars: 128,
  maxDisplayNameChars: 256,
} as const

export type SessionUserInputItem =
  | { type: "text"; text: string }
  | { type: "skill"; name: string; path: string; displayName?: string; source?: SkillSource }
  | { type: "mention"; name: string; path: string; displayName?: string }
```

实现要求：相邻 text 合并、空 text 删除、UTF-8 字节数用 `TextEncoder` 计算、控制字符拒绝、规范文本把 Skill 输出为 `$name`。`SessionInputRecord` 增加必填 `items`，保留派生 `content`；删除 `SkillInvocationMetadata`。

- [ ] **步骤 4：补齐 256/257 items、32/33 Skill、1 MiB 前后一个字节、连续 Skill 和标点相邻测试**

- [ ] **步骤 5：运行协议测试和类型检查**

运行：`pnpm --filter @openharness/protocol test && pnpm --filter @openharness/protocol check-types`

预期：PASS。

- [ ] **步骤 6：提交**

```bash
git add packages/protocol/src/session-input-items.ts packages/protocol/src/session-input-items.test.ts packages/protocol/src/session.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): add structured session input items"
```

---

### 任务 2：让 Skill catalog 与 Skill 工具支持精确 path

**文件：**
- 修改：`packages/server/src/commands/commands.ts`
- 修改：`packages/server/src/commands/default-command-catalog.ts`
- 修改：`packages/server/src/commands/__test__/default-command-catalog.test.ts`
- 修改：`packages/skills/src/index.ts`
- 修改：`packages/skills/src/index.test.ts`
- 修改：`packages/tools/src/meta/skill.ts`
- 修改：`packages/tools/src/meta/skill.test.ts`
- 修改：`apps/desktop/src/shared/session-types.ts`

- [ ] **步骤 1：先写 catalog path 与工具拒绝越界 path 的失败测试**

```ts
expect(await catalog.list({ cwd: "/repo" })).toContainEqual(
  expect.objectContaining({ name: "/review", kind: "template", path: "/repo/.agents/skills/review/SKILL.md" })
)

await expect(skillTool.execute(
  { name: "review", path: "/tmp/foreign/SKILL.md" },
  contextFor("/repo")
)).resolves.toMatchObject({ isError: true })
```

- [ ] **步骤 2：运行失败测试**

运行：`pnpm --filter @openharness/server test -- default-command-catalog.test.ts && pnpm --filter @openharness/skills test && pnpm --filter @openharness/tools test -- skill.test.ts`

预期：FAIL，catalog 没有 path，Skill schema 不接受或不处理 path。

- [ ] **步骤 3：实现最小 path 支持**

给 template catalog entry 增加必填 `path`，session command 不带 path。给 `SkillRegistry` 增加：

```ts
resolvePath(path: string): SkillDefinition | undefined
```

它只在 `getAll()` 的当前赢家中匹配规范化 path；Windows 比较忽略大小写。Skill 工具的 path 是可选字段：有 path 时必须同时匹配 name 与当前 catalog winner；没有 path 时保持现有 `resolve(name)` 行为。

- [ ] **步骤 4：增加同名覆盖测试**

测试 `/user/x/SKILL.md` 被 `/repo/x/SKILL.md` 覆盖后，旧 path 被拒绝，项目 path 可加载；不实现同名多版本列表。

- [ ] **步骤 5：运行相关测试与类型检查**

运行：`pnpm --filter @openharness/skills test && pnpm --filter @openharness/tools test && pnpm --filter @openharness/server test -- default-command-catalog.test.ts`

预期：PASS。

- [ ] **步骤 6：提交**

```bash
git add packages/server/src/commands packages/skills/src packages/tools/src/meta apps/desktop/src/shared/session-types.ts
git commit -m "feat(skills): address explicit skills by catalog path"
```

---

### 任务 3：持久化 items，并明确拒绝旧 Session 输入

**文件：**
- 创建：`packages/services/src/session-runtime/migrations/0017_structured_input_items.sql`
- 修改：`packages/services/src/session-runtime/migrations/meta/_journal.json`
- 修改：`packages/services/src/session-runtime/schema.ts`
- 修改：`packages/services/src/session-runtime/store.ts`
- 修改：`packages/services/src/session-runtime/event-registry.ts`
- 修改：`packages/services/src/session-runtime/__test__/store.test.ts`
- 修改：`packages/services/src/session-runtime/__test__/event-registry.test.ts`

- [ ] **步骤 1：写失败测试，要求新输入持久化和旧输入明确报错**

```ts
const admitted = store.admitInput({
  id: "i1",
  sessionId: "s1",
  delivery: "queue",
  items: [
    { type: "text", text: "use " },
    { type: "skill", name: "review", path: "/repo/review/SKILL.md" },
  ],
  attachments: [],
})
expect(admitted.items).toHaveLength(2)
expect(admitted.content).toBe("use $review")

expect(() => hydrateInput({ ...row, itemsJson: null }))
  .toThrowError(/legacy_session_input_unsupported/)
```

- [ ] **步骤 2：运行 store 测试并确认失败**

运行：`pnpm --filter @openharness/services test -- store.test.ts event-registry.test.ts`

预期：FAIL，schema/store 尚无 `itemsJson`。

- [ ] **步骤 3：实现 migration 和读写**

SQL 使用 nullable 列避免迁移过程自动删除用户数据：

```sql
ALTER TABLE `session_input` ADD `items_json` text;
```

新写入必须写非空 JSON。读取到 `NULL` 时抛出带 code 的 `legacy_session_input_unsupported`，提示用户清理旧 Session 数据；不自动删除、不从 content 猜结构。`content` 始终由 `sessionUserInputText(items)` 派生，不接受调用方另传不同值。

- [ ] **步骤 4：把 `session.input.admitted` durable event 提升为 v2**

让 `sessionDefinition` 接受可选 version，只把 `session.input.admitted` 注册为 2；测试新写入是 v2、读取 v1 返回 `unsupported_version`。

- [ ] **步骤 5：验证内存 store、SQLite 重启、event replay 和旧数据报错**

运行：`pnpm --filter @openharness/services test -- store.test.ts event-registry.test.ts`

预期：PASS。

- [ ] **步骤 6：提交**

```bash
git add packages/services/src/session-runtime
git commit -m "feat(session): persist structured input items"
```

---

### 任务 4：打通 Server 提交、排队、重试、编辑与多 Skill 加载

**文件：**
- 创建：`packages/server/src/application/session/session-input-materializer.ts`
- 创建：`packages/server/src/application/session/__test__/session-input-materializer.test.ts`
- 删除：`packages/server/src/application/session/skill-invocation.ts`
- 修改：`packages/server/src/application/session/session-run-executor.ts`
- 修改：`packages/server/src/application/agent/daemon-agent-event-projector.ts`
- 修改：`packages/server/src/application/session/session-application-service.ts`
- 修改：`packages/server/src/application/session/transcript-projection.ts`
- 修改：对应 `packages/server/src/**/__test__/*.test.ts`
- 修改：`packages/client/src/transport/http-client.ts`
- 修改：`packages/client/src/types/index.ts`

- [ ] **步骤 1：写 materializer 失败测试**

```ts
it("keeps readable markers and emits one ordered skill loading instruction", async () => {
  const result = await materializeSessionInput([
    { type: "text", text: "使用 " },
    { type: "skill", name: "using-superpowers", path: "/skills/super/SKILL.md" },
    { type: "text", text: " 写计划 " },
    { type: "skill", name: "writing-plans", path: "/skills/plan/SKILL.md" },
  ], catalog)
  expect(result.text).toBe("使用 $using-superpowers 写计划 $writing-plans")
  expect(result.skills.map((skill) => skill.path)).toEqual([
    "/skills/super/SKILL.md",
    "/skills/plan/SKILL.md",
  ])
})
```

另测重复 path 只加载一次、同名错误 path 被拒绝、catalog 变化后失败、仅 Skill 输入可提交。

- [ ] **步骤 2：运行 server 测试并确认失败**

运行：`pnpm --filter @openharness/server test -- session-input-materializer.test.ts`

预期：FAIL，materializer 不存在。

- [ ] **步骤 3：实现集中 materializer 并替换单 Skill metadata 注入**

materializer 返回派生正文和有序 Skill 列表。运行时生成一次明确指令，要求模型使用 `Skill` 工具的 `{ name, path }` 逐个加载；不要为每项递归包裹 prompt。删除 `applySkillInvocationToContent`。

- [ ] **步骤 4：迁移 HTTP client 和 Session application 输入**

所有 create/send/queue/steer/retry/edit 路径改收 `items`；attachments 参数保持原样。幂等比较同时比较规范化 items 和 attachments。

- [ ] **步骤 5：迁移 transcript projection**

用户 message part 的 text 使用派生 content；message metadata 保存可安全投影的 items，供 Desktop 行内渲染。不得把 items 重新压回单数 Skill。

- [ ] **步骤 6：运行 client、server、services 回归测试**

运行：`pnpm --filter @openharness/client test && pnpm --filter @openharness/server test && pnpm --filter @openharness/services test`

预期：PASS。

- [ ] **步骤 7：提交**

```bash
git add packages/client packages/server packages/services
git commit -m "feat(session): execute ordered skill input items"
```

---

### 任务 5：将 Desktop 草稿与提交队列迁移为 ComposerDocument

**文件：**
- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/composer-document.ts`
- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/composer-document.test.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/composer-draft-state.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/composer-draft-state.test.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/types.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/prompt-actions.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/session-actions.ts`
- 修改：`apps/desktop/src/shared/session-types.ts`
- 修改：`apps/desktop/src/main/features/session/session-service.ts`
- 修改：相关测试文件。

- [ ] **步骤 1：写草稿迁移失败测试**

```ts
const document = composerDocument([
  textItem("使用 "),
  skillItem({ name: "writing-plans", path: "D:/skills/plan/SKILL.md", displayName: "Writing Plans" }),
])
const next = setDraftDocument(emptyComposerDraftState(), "session:s1", document)
expect(selectDraftDocument(next, "session:s1")).toEqual(document)
expect(selectDraftText(next, "session:s1")).toBe("使用 $writing-plans")
```

- [ ] **步骤 2：运行 Desktop store 测试并确认失败**

运行：`pnpm --filter @openharness/desktop test -- composer-document.test.ts composer-draft-state.test.ts`

预期：FAIL，document API 不存在。

- [ ] **步骤 3：实现 ComposerDocument 和 store selector**

```ts
export interface ComposerDocument {
  version: 1
  items: ComposerInputItem[]
}
```

`DesktopComposerDraft` 保存 `document + attachments`。保留 `selectDraftText` 作为派生 selector，禁止它写回字符串。

- [ ] **步骤 4：迁移 pending submission、queue、steer、retry、edit**

`PendingPromptSubmission` 与 `PendingPromptEdit` 保存 items。提交失败、Session scope 迁移和重试必须复用原 document；成功后仅在提交的 document 仍等于当前 document 时清空。

- [ ] **步骤 5：迁移 Electron IPC 与 main service**

IPC 输入使用 items；main service 只做边界校验与转发，不重新解析 `$name` 或 `/name` 字符串。

- [ ] **步骤 6：运行 Desktop store/main 测试与类型检查**

运行：`pnpm --filter @openharness/desktop test -- composer-document.test.ts composer-draft-state.test.ts prompt-actions.test.ts session-actions.test.ts session-service.test.ts && pnpm --filter @openharness/desktop typecheck`

预期：PASS。

- [ ] **步骤 7：提交**

```bash
git add apps/desktop/src/shared apps/desktop/src/main/features/session apps/desktop/src/renderer/src/stores/desktop-session
git commit -m "feat(desktop): preserve structured composer drafts"
```

---

### 任务 6：实现 Lexical 多 Skill 节点与 `$` / inline `/` 选择

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/desktop/conversation-page/skill-mention-node.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/conversation-page/composer-trigger.ts`
- 创建：`apps/desktop/src/renderer/src/components/desktop/conversation-page/composer-trigger.test.ts`
- 创建：`apps/desktop/src/renderer/src/components/desktop/conversation-page/composer-picker.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/conversation-page/composer-picker.test.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/rich-prompt-input.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/composer.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/conversation-page.tsx`
- 删除：`apps/desktop/src/renderer/src/components/desktop/conversation-page/skill-command-pill-node.tsx`
- 修改或删除：`composer-skill-commands.ts`、`skill-command-menu.tsx` 及其测试。

- [ ] **步骤 1：写 trigger 失败测试**

```ts
expect(findComposerTrigger("请用 /wri", 7)).toEqual({ sigil: "/", query: "wri", from: 3, to: 7, mode: "inline" })
expect(findComposerTrigger("/rev", 4)).toEqual({ sigil: "/", query: "rev", from: 0, to: 4, mode: "leading" })
expect(findComposerTrigger("请用 $wri", 7)).toEqual({ sigil: "$", query: "wri", from: 3, to: 7, mode: "inline" })
expect(findComposerTrigger("https://x/y", 11)).toBeNull()
expect(findComposerTrigger("请用（/wri", 7)).toBeNull()
expect(findComposerTrigger("$$HOME", 6)).toBeNull()
```

- [ ] **步骤 2：运行 trigger 测试并确认失败**

运行：`pnpm --filter @openharness/desktop test -- composer-trigger.test.ts`

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现 trigger 与共享 picker**

trigger 只在文档开头、ASCII 空白后或原子节点后成立；query 字符为 `[A-Za-z0-9._:-]`。picker 接收已经过滤好的 section，负责 Arrow、Enter、Tab、Escape 与鼠标交互。

- [ ] **步骤 4：先写 SkillMentionNode 样式失败测试**

```ts
expect(html).toContain("text-primary")
expect(html).not.toMatch(/bg-|rounded-|border-|px-/)
expect(node.getTextContent()).toBe("$writing-plans")
```

- [ ] **步骤 5：实现无胶囊节点和 Lexical document codec**

节点使用 `Box` 14px 图标、`text-primary`、`font-medium`、基线对齐；保存 name/path/displayName/source。Lexical 更新监听器导出完整 document，外部恢复按 items 重建多个节点。内部粘贴数据仍需 catalog 再验证；普通文本 `$name` 不自动提升。

- [ ] **步骤 6：接入 `$` 和 inline `/`**

两种入口都只显示 Skill 并调用同一个 `insertSkillMention(range, skill)`。选中后替换 trigger range、插入一个原子节点和必要空格，将光标移到节点后。

- [ ] **步骤 7：验证多个引用、删除、方向键、IME 与粘贴**

运行：`pnpm --filter @openharness/desktop test -- composer-trigger.test.ts composer-picker.test.tsx rich-prompt-input.test.tsx`

预期：PASS。

- [ ] **步骤 8：提交**

```bash
git add apps/desktop/src/renderer/src/components/desktop/conversation-page
git commit -m "feat(desktop): compose multiple inline skill mentions"
```

---

### 任务 7：实现首字符 `/` 的动态应用命令菜单

**文件：**
- 修改：`packages/server/src/commands/commands.ts`
- 修改：`packages/client/src/commands/session-commands.ts`
- 修改：`apps/desktop/src/shared/session-types.ts`
- 修改：`apps/desktop/src/shared/ipc-channels.ts`
- 修改：`apps/desktop/src/main/features/session/session-service.ts`
- 修改：`apps/desktop/src/main/features/session/ipc.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/composer-picker.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/conversation-page.tsx`
- 修改：对应测试。

- [ ] **步骤 1：写动态菜单失败测试**

```ts
expect(pickerItems({ trigger: leadingSlash, commands, skills }).map(item => item.id))
  .toEqual(expect.arrayContaining(["review", "compact", "skill:writing-plans"]))

expect(pickerItems({ trigger: inlineSlash, commands, skills }).map(item => item.id))
  .toEqual(["skill:writing-plans"])
```

- [ ] **步骤 2：运行测试并确认首字符菜单尚未包含 session command**

运行：`pnpm --filter @openharness/desktop test -- composer-picker.test.tsx`

预期：FAIL。

- [ ] **步骤 3：给命令 catalog 增加明确 composer 行为**

```ts
type CommandSelection = "execute" | "submenu" | "insert"

interface CommandCatalogEntry {
  // existing fields
  requiresEmptyComposer?: boolean
  selection?: CommandSelection
}
```

所有有副作用的 session command 默认 `requiresEmptyComposer: true`。没有 Desktop 执行适配器的命令不返回给 Desktop 菜单。

- [ ] **步骤 4：接入最小可验证命令集**

首批接入仓库已经有明确 API 的 `/compact`、`/status`、`/skills`：

- `/compact` 调用 `OpenHarnessClient.compactSession`，运行中禁用，成功后刷新 Session。
- `/status` 打开只读状态展示，不发送 prompt。
- `/skills` 打开现有 Skill 管理/列表入口，不发送 prompt。

Review 当前没有等价 Desktop API，不伪造支持；等独立 Review 功能存在后再注册。该取舍保持“行为对齐”，不假装“命令库存完全相同”。

- [ ] **步骤 5：实现选择、取消与失败恢复**

执行前保存 ComposerDocument；清除 slash token 后执行。动作失败时恢复完整 document；submenu 关闭时恢复 token；inline slash 永远看不到 application command。

- [ ] **步骤 6：运行命令、IPC 和组件测试**

运行：`pnpm --filter @openharness/client test -- session-commands.test.ts && pnpm --filter @openharness/desktop test -- composer-picker.test.tsx session-service.test.ts ipc.test.ts`

预期：PASS。

- [ ] **步骤 7：提交**

```bash
git add packages/server/src/commands packages/client/src/commands apps/desktop/src/shared apps/desktop/src/main/features/session apps/desktop/src/renderer/src/components/desktop/conversation-page
git commit -m "feat(desktop): add contextual slash command menu"
```

---

### 任务 8：从结构化 items 渲染 transcript，并删除单 Skill 路径

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message-block.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/transcript.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/optimistic-transcript.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/optimistic-transcript.test.ts`
- 删除单数 `skillInvocation` 在 `apps/desktop`、`packages/server`、`packages/services` 中的剩余调用与测试 fixture。

- [ ] **步骤 1：写 optimistic 与 confirmed transcript 失败测试**

```ts
expect(renderUserItems([
  { type: "text", text: "使用 " },
  { type: "skill", name: "a", path: "/a/SKILL.md", displayName: "Skill A" },
  { type: "text", text: " 然后 " },
  { type: "skill", name: "b", path: "/b/SKILL.md", displayName: "Skill B" },
])).toEqual([
  { kind: "text", text: "使用 " },
  { kind: "skill", name: "a", displayName: "Skill A" },
  { kind: "text", text: " 然后 " },
  { kind: "skill", name: "b", displayName: "Skill B" },
])
```

断言没有顶部 capsule、没有 `SKILL.md` 路径、optimistic 与确认后 HTML 的关键结构一致。

- [ ] **步骤 2：运行 transcript 测试并确认失败**

运行：`pnpm --filter @openharness/desktop test -- transcript.test.ts optimistic-transcript.test.ts`

预期：FAIL，当前只读取单数 metadata capsule。

- [ ] **步骤 3：实现共享行内 renderer**

从 message/input metadata 的 items 渲染 text 与 Skill；Skill 复用输入框的视觉组件但不具备编辑行为。路径只用于身份，不进入 title 或 DOM 文本。

- [ ] **步骤 4：删除旧单 Skill 生产代码和 fixture**

运行：`rg -n "SkillInvocationMetadata|skillInvocation|SkillCommandPillNode|parseSkillCommandInvocation|applySkillInvocationToContent" apps packages`

预期：只允许设计/迁移说明中的文字引用；生产代码与测试 fixture 为零。

- [ ] **步骤 5：运行 Desktop 全量测试和类型检查**

运行：`pnpm --filter @openharness/desktop test && pnpm --filter @openharness/desktop typecheck`

预期：PASS，输出无 warning/error。

- [ ] **步骤 6：提交**

```bash
git add apps/desktop packages/server packages/services
git commit -m "feat(desktop): render structured skill mentions"
```

---

### 任务 9：全链路验收与清理

**文件：**
- 修改：仅修复验证中暴露的相关文件。

- [ ] **步骤 1：运行格式和静态检查**

运行：`pnpm lint && pnpm check-types`

预期：PASS。

- [ ] **步骤 2：运行受影响包的完整测试**

运行：`pnpm --filter @openharness/protocol test && pnpm --filter @openharness/skills test && pnpm --filter @openharness/tools test && pnpm --filter @openharness/services test && pnpm --filter @openharness/server test && pnpm --filter @openharness/client test && pnpm --filter @openharness/desktop test`

预期：全部 PASS。

- [ ] **步骤 3：手工验收 Desktop**

逐项验证：

1. 空输入键入 `/`：出现 `/compact`、`/status`、`/skills` 和 Skill。
2. 正文后键入 ` /`：只出现 Skill，不出现 `/compact`。
3. 正文后键入 ` $`：出现 Skill。
4. 用 `/` 和 `$` 各插入一个 Skill：两者都是蓝色图标加名称，无胶囊。
5. 提交、queue、steer、失败重试和编辑最新消息：两个 Skill 的顺序不丢。
6. Backspace/Delete 整体删除引用，方向键可越过节点，中文 IME 不误提交。
7. 外部粘贴 `$name` 保持纯文本；catalog 外 path 提交被拒绝且草稿保留。
8. 旧数据库存在 `items_json IS NULL` 时显示明确的不兼容提示，不自动删除记录。

- [ ] **步骤 4：检查 diff 与工作区**

运行：`git diff --check && git status --short`

预期：无空白错误，只包含本计划相关文件。

- [ ] **步骤 5：确认所有修复已归入对应任务提交**

如果步骤 1-4 暴露问题，返回产生问题的任务，先写最小回归测试、修复、运行该任务的验证命令并提交；然后从步骤 1 重新执行本任务。最终验收阶段不创建笼统的清理提交。
