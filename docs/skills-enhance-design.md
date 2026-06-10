# 设计：Skills 增强 + 内置 skills（E.5）

> 状态：已批准，待实现。

## 目标

1. **user-invocable skill 当 `/<skill>` 斜杠命令**：输入 `/<name> [args]` → 把 skill 内容作为一次 prompt 注入引擎跑（带 args、可选 model 覆盖）。
2. **内置 skills**：随包发一批（commit/review/test/plan/debug），默认加载。
3. **frontmatter 扩展**：解析 user-invocable / disable-model-invocation / model / argument-hint。
4. **model 可见性**：`disable-model-invocation` 的 skill 不进 Skill 工具 / system prompt（模型看不到，只能用户斜杠调）。

## 现状

- `SkillDefinition { name, description, content, path, source?, metadata? }`；`parseSkillMarkdown` 只取 name/description。
- `Skill` 工具（模型调）+ `/skills list|show`（已有）。无 `/<skill>` 直接调用。
- skills 在 main.ts 的 runRepl/runPrintMode/runBackendHost 从 `getSkillsDir()` + `cwd/.openharness/skills` 加载。
- Python frontmatter 字段：name/description/command_name?/display_name?/user_invocable(默认 true)/disable_model_invocation(默认 false)/model?/argument_hint?。

## 组件

### a) skills 包：frontmatter 扩展
- `SkillDefinition` 加：`userInvocable: boolean`(默认 true)、`disableModelInvocation: boolean`(默认 false)、`model?: string`、`argumentHint?: string`、`commandName?: string`、`displayName?: string`。
- `parseSkillMarkdown` 解析这些字段（frontmatter 里的 `user-invocable`/`disable-model-invocation`/`model`/`argument-hint`，布尔解析 true/false/1/0/yes/no）。
- 返回类型 `ParsedSkillMeta` 同步扩展。

### b) 内置 bundled skills（TS 内嵌，运行时稳定）
- 新建 `packages/skills/src/bundled.ts`：导出 `BUNDLED_SKILLS: SkillDefinition[]`，每个 `source:"bundled"`，content 用 markdown 模板串。
- 首发 5 个：**commit / review / test / plan / debug**（简洁实用的方法论，对标 Claude Code skill 风格）。
- `SkillRegistry`/`SkillLoader` 默认注册 bundled（提供 `registerBundled()` 或 loader 默认加载）。
- **来源优先级**：bundled < user(getSkillsDir) < project(cwd/.openharness/skills + cwd/.claude/skills)——同名后者覆盖前者（register 时覆盖即可，按加载顺序）。
- 选 TS 内嵌而非 .md 文件：避免 bun-built 后运行时找 .md 路径的脆弱；user/project skills 仍是 SKILL.md 文件（用 parseSkillMarkdown）。

### c) `/<skill>` 斜杠命令
- **REPL**（apps/cli/src/commands/main.ts `processLine`）：在走 commandRegistry 之前，若 `/<word>` 匹配某个 `userInvocable` skill 名（且不与内置命令冲突，内置优先）→ 构造 prompt = `skill.content`（+ 末尾拼用户 args，按 argumentHint 提示）→ 走与普通输入相同的 `queryEngine.submitMessage` 路径**跑一轮**（不是返回文本）。
- **backend host**（runBackendHost 的 submit_line）：同样在 runHostSlashCommand 之前拦截 user-invocable skill → 走 processLineForHost（注入 skill prompt）。
- **命令列表**：buildHostCommandList / REPL 的命令补全把 user-invocable skill 显示为 `/<name>`（描述用 skill.description）。
- 若 skill.model 设了：最小版**先不做**每命令 model 覆盖（注 TODO）；统一用当前会话 model。

### d) model 可见性
- Skill 工具（packages/tools/src/meta/skill.ts）：列出/可发现 skill 时排除 `disableModelInvocation`（但若模型显式按名取且该 skill disableModelInvocation，可仍拒绝或允许——最小版：Skill 工具仍能按名取，但**system prompt 的 skills 段**排除 disableModelInvocation 的，使模型不会主动发现/调用）。
- system prompt skills 段（buildRuntimeSystemPrompt 的 skillsList 来源）：过滤掉 `disableModelInvocation` 的 skill。

## 测试

- `parseSkillMarkdown`：解析 user-invocable/disable-model-invocation/model/argument-hint + 默认值（缺省 userInvocable=true、disableModelInvocation=false）。
- bundled：BUNDLED_SKILLS 非空、字段合法；三源覆盖（同名 project 覆盖 user 覆盖 bundled）。
- `/<skill>` 注入：可测函数判断 `/<word>` 是否 user-invocable skill + 构造的 prompt 含 skill.content + args；内置命令优先（`/help` 不被 skill 覆盖）。
- model 可见性：disableModelInvocation 的 skill 不在 system-prompt skills 列表。

## 范围外

- project skills 的 git-root 向上逐级遍历 + least→most（最小版 cwd 单层 + 三源覆盖）。
- 信任门控 + 路径穿越防护（留 TODO）。
- 每命令 model 覆盖、command_name/display_name 的完整路由、skill-creator/diagnose 重工作流 skill。
