# Skills 加载与调用流程（E.5）

skill 是一段带 frontmatter 的 Markdown「方法论/提示词」。它有**两条调用路径**：
**用户**输入 `/<skill>` 斜杠命令触发，或 **模型**通过 `Skill` 工具按需拉取。本文讲
skill 从哪加载、怎么进 system prompt、两条路径分别怎么跑。

## 涉及的模块

| 组件 | 文件 | 职责 |
|------|------|------|
| `SkillRegistry` / `SkillLoader` | `packages/skills/src/index.ts` | 注册表、`parseSkillMarkdown`（frontmatter）、`registerBundled` / `loadFromDirectory`、`modelVisibleList()` |
| `BUNDLED_SKILLS` | `packages/skills/src/bundled.ts` | 内置 5 个 skill（commit/review/test/plan/debug，TS 内嵌） |
| 三源加载 | `apps/cli/src/commands/main.ts` `loadSkillsThreeSources` | bundled → user → project，同名覆盖 |
| `/<skill>` 拦截 | `apps/cli/src/commands/main.ts` `matchUserInvocableSkill` / `buildSkillPrompt` | 用户斜杠路径：匹配 user-invocable skill → 注入内容跑一轮 |
| 命令列表 | `apps/cli/src/commands/main.ts` `buildHostCommandList` | 把 user-invocable skill 显示为 `/<name>` |
| model 可见性 | `runtime.ts`（bootstrap）+ `main.ts`（refreshSystemPrompt） | `modelVisibleList()` → system prompt 的 skills 段 |
| `Skill` 工具 | `packages/tools/src/meta/skill.ts` | 模型路径：按名取 skill 内容 |
| system prompt | `packages/prompts/src/index.ts` `buildRuntimeSystemPrompt(skillsList)` | 把 model 可见 skill 列给模型 |

## 整体模型（三来源 → 一注册表 → 两消费者）

```
┌──────────────── 加载（三来源，bundled < user < project，同名覆盖） ────────────────────────────────────────┐
│  registerBundled()      loadFromDirectory(getSkillsDir())   findProjectSkillDirs(cwd)                      │
│  内置 5 个(TS 内嵌) <   ~/.openharness/skills(用户)      <  git-root→cwd 每层 .openharness/skills          │
│  source:"bundled"       source:"user"                        + .claude/skills（cwd 层最高优先）             │
└───────────────────────────────────────────────────┬──────────────────────────────────────────────────────┘
                                        ▼
                              ┌────────────────────┐
                              │   SkillRegistry    │  每个 SkillDefinition:
                              │  (name → 定义)     │  name/description/content +
                              └─────────┬──────────┘  userInvocable/disableModelInvocation/
                                        │             model/argumentHint
                        ┌───────────────┴────────────────┐
                        ▼                                ▼
        ┌──────────────────────────┐      ┌──────────────────────────────────┐
        │ 用户路径（斜杠命令）      │      │ 模型路径（Skill 工具）            │
        │                          │      │                                  │
        │ /<skill> [args]          │      │ system prompt 列出               │
        │  → matchUserInvocableSkill│      │  modelVisibleList()（排除         │
        │  → buildSkillPrompt       │      │  disableModelInvocation）         │
        │  → submitMessage 跑一轮   │      │  → 模型调 Skill{name} 取 content  │
        └──────────────────────────┘      └──────────────────────────────────┘
        条件：userInvocable=true            条件：disableModelInvocation=false
              且不撞内置命令                       （否则模型看不到名字）
```

**两个开关的语义**（frontmatter）：

| `userInvocable` | `disableModelInvocation` | 谁能调 |
|---|---|---|
| true（默认） | false（默认） | 用户 `/<skill>` + 模型 `Skill` 工具 |
| true | **true** | 只有用户 `/<skill>`（模型看不到，"我的手动按钮"）|
| false | — | 不做斜杠命令（内部/纯模型用）|

## 调用方式速查（`/skills` 是「看」，`/<skill>` 是「用」）

| 命令 | 动作 | 说明 |
|------|------|------|
| `/skills` | **列出**所有 skill | 已有命令 |
| `/skills <name>` | **查看**某 skill 的内容（只读，**不跑**） | 已有命令 |
| `/<skill> [args]` | **执行** skill（注入内容**跑一轮**） | E.5 新增；仅 `userInvocable` 且不撞内置命令的可用 |
| `/commit`、`/plan` | 走**内置命令**（git-commit / plan-mode），**不是** skill | 撞名 → 内置优先 |

- 内置 5 个里：`/review`、`/test`、`/debug` 可直接 `/<skill>` 执行；`/commit`、`/plan`
  被同名内置命令遮蔽（用户入口走内置，模型仍可经 `Skill` 工具用这两个 skill）。
- 模型不输入斜杠——它走的是下面「模型路径」，按需调 `Skill` 工具。

## 用户路径：`/<skill>` 跑一轮

```
用户输入：/review src/foo.ts
         │
         ▼
┌──────────────────────────────────────────────────────────┐
│ Step 1 · 拦截（在内置命令之前）                            │
│ REPL processLine / backend submit_line：                  │
│   matchUserInvocableSkill("/review src/foo.ts", registry, │
│                           isBuiltinCommand)               │
│   ├─ cmdName="/review" 是内置命令? → 是则放回内置(优先)    │
│   ├─ "review" 命中 userInvocable skill? → 命中            │
│   └─ 返回 { skill, args:"src/foo.ts" }                     │
└──────────────────────────┬───────────────────────────────┘
                           │ 命中
                           ▼
┌──────────────────────────────────────────────────────────┐
│ Step 2 · 构造 prompt                                      │
│ buildSkillPrompt(skill, args) =                           │
│   skill.content + "\n\n## Arguments\nsrc/foo.ts"          │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│ Step 3 · 跑一轮（与普通输入同路径）                       │
│ queryEngine.submitMessage(prompt) → 流式渲染              │
│   REPL：EventRenderer 渲染到 stdout                       │
│   backend：processLineForHost emit 事件(transcript/delta) │
│   busy 标志/错误处理与普通消息一致                        │
└──────────────────────────────────────────────────────────┘
```

**未命中**（不是 user-invocable skill、或撞了内置命令）→ 落回原斜杠命令路由
（commandRegistry / runHostSlashCommand），不会吞命令。

## 模型路径：`Skill` 工具

```
bootstrap / refreshSystemPrompt
   │  skillsList = skillRegistry.modelVisibleList()
   │  （排除 disableModelInvocation 的）
   ▼
system prompt 的 "Available Skills" 段（REPL / print / backend 三模式一致）
   │
   ▼
模型看到 skill 列表 → 需要时调 Skill{ name:"debug" }
   │
   ▼
Skill 工具返回 skill.content → 模型据此行事
```

> 注：之前 skills **从未进 system prompt**（参数存在但无人传）；E.5 把
> `modelVisibleList()` 接进三模式，模型才第一次「知道有哪些 skill」。

## 关键点

- **三源优先级**：`bundled < user < project`，按加载顺序 `register` 覆盖（后者赢）。project 层内部，`git-root` 层 < `cwd` 层（`findProjectSkillDirs` 以 root→cwd 顺序返回，cwd 最后加载故最高优先）。
- **内置命令优先**：`/<skill>` 撞内置斜杠命令时内置赢——内置 `commit`/`plan` 因此遮蔽了
  同名 bundled skill 的**用户**入口（仍可被模型经 Skill 工具使用）；`review`/`test`/`debug`
  不撞名、可正常 `/<skill>` 调用。与 Python 一致。
- **两开关正交**：`userInvocable`（管用户斜杠）与 `disableModelInvocation`（管模型可见）独立。
- **model 可见性三模式一致**：REPL 走 refreshSystemPrompt，print/backend 走 bootstrap，
  都用 `modelVisibleList()`。
- **bundled 用 TS 内嵌**而非 .md 文件：避免 bun-built 后运行时找文件路径的脆弱；
  user/project skills 仍是 `SKILL.md` 文件（经 `parseSkillMarkdown`）。

## 留待后续

- **每命令 model 覆盖**（frontmatter `model` 暂未让 `/<skill>` 切模型）。
- `command_name`/`display_name` 完整路由；skill-creator / diagnose 等重工作流 skill。

## 已完成的增强（E.5 尾巴）

- ✅ **git-root 向上逐级遍历**：`findProjectSkillDirs(cwd)` 从 cwd 走到 `.git` 根，每层收
  `.openharness/skills` 和 `.claude/skills`，以 root→cwd 顺序返回（cwd 层优先级最高）。
  `loadSkillsThreeSources` 已改用此函数，替代原来只加载 `join(cwd, ...)` 单层的实现。
- ✅ **路径穿越防护**：`discoverMarkdownFiles` 对每个 entry 用 `path.resolve + path.sep`
  校验绝对路径必须位于 `dirPath` 之内，防止 symlink 或含 `..` 的文件名逃逸到目录外。
