# @openharness/skills

Skill 加载和解析系统。

## 功能

- Skill 解析 (markdown frontmatter)
- Skill 发现
- 内容加载

## 使用

```ts
import { SkillRegistry } from "@openharness/skills";

const registry = new SkillRegistry();
registry.discover(cwd);
const skill = registry.get("skill-name");
```

## 测试

```bash
pnpm --filter @openharness/skills test
```

现在我已全面了解情况。以下是详细的流程：

---

## Skill 完整流程

### 一、Skill 文件解析（`parseSkillMarkdown`）

一个 skill 就是一个 `.md` 文件，放在 `~/.openharness/skills/` 或 `<cwd>/.openharness/skills/` 下。解析分两级：

**第一优先级：YAML Frontmatter**
```markdown
---
name: code-reviewer
description: Review code for best practices
---
（正文作为 content 存储）
```
解析 `---` 之间的 `name:` 和 `description:` 行，去引号。

**第二优先级：正文回退**
- 没有 frontmatter → 从第一个 `# 标题` 提取 name
- 从第一个非标题、非空行提取 description（截断 200 字符）
- 最终 fallback → `name = 文件名（去 .md）`, `description = "Skill: {name}"`

### 二、加载流程（`SkillLoader`）

```
CLI 启动
  │
  ├─ new SkillRegistry()
  ├─ new SkillLoader(registry)
  ├─ await loader.loadFromDirectory(getSkillsDir())        ← ~/.openharness/skills/
  │     ├─ discoverMarkdownFiles(dir) → 找到所有 .md 文件
  │     └─ 对每个文件: readFile → parseMarkdown → registry.register(skill)
  │
  ├─ await loader.loadFromDirectory(cwd/.openharness/skills/)  ← 项目级 skills
  │
  └─ skillRegistry 传入 bootstrap() → QueryEngineOptions → 存储在 QueryEngine 中
```

**`SkillDefinition` 结构：**
```ts
{
  name: "code-reviewer",       // 来自 frontmatter 或文件名
  description: "Review code",  // 来自 frontmatter 或正文首行
  content: "# Code Reviewer\n\n...", // 完整 Markdown 原文
  path: "/home/user/.openharness/skills/code-reviewer.md",
  source?: "bundled" | "user" | "plugin",
}
```

### 三、Agent 调用流程

**方式 A：AI 主动调用 `Skill` 工具**

```
用户: "帮我 review 这段代码"
  │
  ▼
LLM 返回 tool_use: { name: "Skill", input: { name: "code-reviewer" } }
  │
  ▼
QueryEngine.executeTools() → skillTool.execute({ name: "code-reviewer" }, context)
  │
  ├─ context.skillRegistry 存在？  ──是──→  直接用它（共享注册表）
  │                                      ──否──→  懒加载: new SkillRegistry + SkillLoader
  │
  ├─ registry.get("code-reviewer")            ← 精确匹配
  │   ?? registry.get("code-reviewer")        ← 小写匹配
  │   ?? registry.get("Code-reviewer")        ← 首字母大写匹配
  │
  └─ 返回 { content: [{ text: "完整的 Markdown 内容" }] }
      │
      ▼
LLM 拿到 skill 的完整 Markdown 内容作为工具结果
  │
  ▼
LLM 根据 skill 内容中的指令执行后续操作（如调用 Bash/Read/Edit 等）
```

**方式 B：用户通过 `/skills` 命令查看**

```
用户输入: /skills
  │
  ▼
SlashCommandContext.skillRegistry.getAll() → 列出所有已加载的 skills
  │
  ▼
显示: name, description, source, path
```

### 四、关键数据流图

```
┌─────────────────────────────────────────────────────┐
│  启动时加载                                          │
│                                                     │
│  ~/.openharness/skills/*.md  ─┐                     │
│                               ├─ SkillLoader ──────►│ SkillRegistry (内存 Map)
│  <cwd>/.openharness/skills/*.md ─┘                  │   { name → SkillDefinition }
│                                                     │
└──────────────────────────────┬──────────────────────┘
                               │
          ┌────────────────────┼──────────────────┐
          ▼                    ▼                   ▼
     bootstrap()        slashCtx           ToolContext
     (→QueryEngine)     (→/skills命令)     (→skillTool)
          │
          ▼
     AI 调用 "Skill" 工具
          │
          ▼
     skillTool.execute()
          │
          ├─ 优先用 context.skillRegistry（共享，已预加载）
          │
          └─ fallback: 新建注册表 + 按需加载（无共享时的降级）
          │
          ▼
     返回 skill.content（完整 Markdown）
          │
          ▼
     LLM 读取 skill 内容，按其中的指令执行
```

### 五、与 Python 版的差异

| 方面 | Python | TS（当前） |
|------|--------|-----------|
| Skill 调用方式 | AI 调 `Skill` 工具，返回 Markdown 内容 | 相同 |
| 内置 skills | 有（`bundles/skills/`） | **无**（目录为空） |
| 加载时机 | 启动时加载 | 相同（刚修复） |
| subagentType 关联 | `subagent_type` 可选，通过 Coordinator 映射 | `subagentType` 可选，通过 coordinator `getAgentDefinition` 映射 |

### 六、当前缺口

1. **没有内置 skill 文件** — `~/.openharness/skills/` 和 `<cwd>/.openharness/skills/` 通常为空，需要用户提供或后续补充内置 skills
2. **Skill 内容只是被"阅读"** — LLM 拿到 Markdown 后自行决定是否遵循其中的指令，没有强制执行机制
3. **source 字段未使用** — `SkillDefinition.source` 可标记 `"bundled" | "user" | "plugin"`，但加载时从未设置