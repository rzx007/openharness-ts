# 设计：Plugins 贡献加载·核心集（C.1）

> 状态：已批准。重写 `packages/plugins`，让插件从「只读清单的空壳」变成真正能给
> 系统注入 skills / commands / hooks / MCP 的扩展机制。移植自 Python
> `plugins/loader.py`（730 行）+ `schemas.py` + `installer.py`。

## 范围

**本轮（核心集）**：发现 + 信任门控 + skills/commands/hooks/MCP 四类贡献 +
`${CLAUDE_PLUGIN_ROOT}` + 卸载路径穿越防护。

**范围外（留后续）**：
- plugin agents（依赖 C.4 的 agent .md frontmatter 解析器）；
- bundled plugins（Python 侧也是空目录）。

**已补充完成（C.1 二刀）**：`tools_dir` 动态 import 工具——`registerPluginTools` 函数遍历 `<plugin>/<tools_dir>/*.js|ts`，动态 import 后验证 `name` 与 `execute` 字段，通过则注册进 `toolRegistry`；import 失败只打 stderr 警告，不影响其他工具与插件加载。REPL / BackendHost / task-worker 三路均已在 `registerPluginHooks` 之后调用。

## Claude Code 兼容

插件目录布局完全对齐 Claude Code 的插件格式（Python 原版即按此移植），
一个 Claude Code 插件文件夹放进 `~/.openharness/plugins/` 应可直接生效：

| Claude Code 约定 | 支持方式 |
|------------------|----------|
| `.claude-plugin/plugin.json` | 与根级 `plugin.json` 二选一，根级优先 |
| `commands/**/*.md`（含子目录命名空间） | 递归发现，命名 `plugin:ns:name` |
| 目录式 skill（`<dir>/SKILL.md`） | commands 递归遇 SKILL.md 截断；skills_dir 同布局 |
| `hooks/hooks.json` 结构化格式（matcher + hooks[]） | 支持，`${CLAUDE_PLUGIN_ROOT}` 替换为插件根绝对路径 |
| `.mcp.json` | 与 manifest 指定的 `mcp.json` 二选一 |
| frontmatter：`description/argument-hint/model/user-invocable/disable-model-invocation` | 解析并保留 |
| frontmatter：`allowed-tools/when_to_use/version/effort` | 不解析（TS 斜杠命令消费面用不到，留待需要时补） |

## 目录与发现（R1）

```
~/.openharness/plugins/<name>/          # 用户插件（默认加载）
<cwd>/.openharness/plugins/<name>/      # 项目插件（默认不加载，须 allowProjectPlugins）
```

- `findManifest(dir)`：`plugin.json` → `.claude-plugin/plugin.json`，都没有则不是插件。
- `discoverPluginPaths(settings, cwd, extraRoots?)`：按 root 顺序、目录名排序，去重。
- **信任门控**：`settings.allowProjectPlugins !== true` 时跳过项目 root；若项目
  目录里确有插件，告警一次（「检测到项目插件但默认禁用，信任此工作区请设
  allowProjectPlugins=true」）。
- **启停**：`enabled = settings.enabledPlugins[name] ?? manifest.enabled_by_default`；
  disabled 的插件仍出现在 LoadedPlugin 列表（带 enabled:false，供 /plugin 列表展示），
  但其贡献不注册。

### 清单 schema（zod，snake_case 对齐 Python/Claude Code）

```ts
PluginManifest {
  name: string;                    // 必填
  version: string = "0.0.0";
  description: string = "";
  enabled_by_default: boolean = true;
  skills_dir: string = "skills";
  tools_dir: string = "tools";     // 动态 import（registerPluginTools，C.1 二刀已实现）
  hooks_file: string = "hooks.json";
  mcp_file: string = "mcp.json";
  author?: object;
  commands?: string | string[] | Record<string, { source?, content?, description?, argumentHint?, model?, allowedTools? }>;
  agents?: string | string[];      // 本轮只存不加载
  skills?: string | string[];
  hooks?: string | object | array;
}
```

### LoadedPlugin

```ts
LoadedPlugin {
  manifest: PluginManifest;
  path: string;
  enabled: boolean;
  skills: SkillDefinition[];           // source: "plugin"
  commands: PluginCommandDefinition[];
  hooks: Record<string, PluginHookEntry[]>;   // event → hooks
  mcpServers: Record<string, unknown>;        // name → server config
}
```

### Settings 新增

`allowProjectPlugins?: boolean`（缺省 false）、`enabledPlugins?: Record<string, boolean>`（缺省 {}）。

## skills + commands 贡献（R2）

- **skills**：`<plugin>/<skills_dir>/` 下两种布局——目录本身就是 skill
  （`skills_dir/SKILL.md`）或子目录每个一个 skill（`skills_dir/<name>/SKILL.md`）。
  复用 `@openharness/skills` 的 frontmatter 解析（需导出解析函数），
  `source:"plugin"`。
- **commands**：
  - 默认 `commands/` 目录递归（`followlinks`，遇 SKILL.md 截断该目录、SKILL.md
    本身算一条 skill 型命令）；
  - manifest `commands` 三形态：字符串/数组（路径，目录或 .md 文件）、
    字典（`{name: {source: 路径}}` 或 `{name: {content: 内联}}`，metadata 覆盖 frontmatter）；
  - 命名：`<plugin>:<相对目录命名空间>:<文件名/skill目录名>`；
  - 去重：resolve 后同一文件只加载一次（默认目录 + manifest 路径重叠时）。
- **接线（apps/cli）**：三模式启动时 `loadPlugins(settings, cwd)` →
  enabled 插件的 skills 注册进 SkillRegistry（在 bundled<user<project 之后，
  即 plugin 优先级最低、同名让位——与 Python registry 合并顺序一致）；
  commands 注册为斜杠命令（用户敲 `/plugin:cmd`，行为同 skill 斜杠命令：
  内容作为 prompt 注入）。

## hooks + MCP + 卸载防护（R3）

- **hooks 平铺格式**（`hooks_file`，缺省 `hooks.json`）：
  `{ "<event>": [ { type: "command", command, ... } ] }`，event 名与
  `@openharness/hooks` 的事件集对齐。
- **hooks 结构化格式**（`hooks/hooks.json`，Claude Code 风格，平铺缺失时回退）：
  `{ "hooks": { "<event>": [ { matcher, hooks: [{type, command, timeout}] } ] } }`；
  `${CLAUDE_PLUGIN_ROOT}` → 插件根绝对路径。
- **接线**：enabled 插件的 hooks 注册进 HookExecutor（带来源标记）。
- **MCP**：`mcp_file`（缺省 `mcp.json`）→ 回退 `.mcp.json`；解析为
  `mcpServers` map；接线时合并进 MCP 配置，**用户 settings 同名 server 优先**，
  插件不覆盖。
- **installer 防护**：`install`/`uninstall` 校验插件名（`[A-Za-z0-9._@-]+`，
  拒绝 `..`/路径分隔符/绝对路径）——字符集白名单本身已排除一切穿越构造，
  无需额外 resolve 断言（对齐 PLAN-REMAINING 的「卸载时拒绝 `..`/绝对路径」）。

## 与 Python 差异

| 点 | Python | TS | 原因 |
|----|--------|----|------|
| 发现目录 mkdir | `get_user_plugins_dir` 等读路径也 mkdir | 发现走纯路径计算，不建目录 | 避免查询留空目录（swarm D.5 的同类教训） |
| agents / tools 贡献 | loader 里有 | 本轮不做（字段保留） | agents 依赖 C.4 解析器；tools 是代码执行面 |
| YAML frontmatter | PyYAML safe_load | 复用 skills 包现有解析 | 不引新依赖 |
| 贡献消费 | cli.py/registry/mcp config 多点合并 | apps/cli 统一接线函数 | TS 三模式共用一条加载链 |
| commands/ 根级 SKILL.md | `relative_to` 抛 ValueError（crash） | `basename(dir)` 兜底正常加载 | 修 Python 的边界崩溃 |
| 坏贡献文件 | `load_plugin` 未捕获，整体崩 | try/catch → 该插件跳过 | 坏插件不拖垮 CLI 启动 |
| flat hooks 事件名 | 不校验 | 按 `HOOK_EVENTS` 白名单过滤 | 错事件名静默挂不上不如显式丢弃 |
| flat hooks 为空对象时 | 不回退结构化 | 回退 `hooks/hooks.json` | 空平铺视作未提供更合理 |

## 测试

- R1：manifest 解析（缺省值/非法 JSON/缺 name）、`.claude-plugin` 备选、双源发现
  排序去重、信任门控（默认跳过项目插件 + 告警）、enabledPlugins 覆盖。
- R2：skills 两种布局、commands 目录递归/SKILL.md 截断/三形态 manifest/命名
  空间/去重、frontmatter 元数据 override。
- R3：hooks 两格式 + `${CLAUDE_PLUGIN_ROOT}` 替换、MCP 两文件回退、合并不覆盖
  用户、uninstall 穿越拒绝。
- 接线：临时插件目录端到端——load 后 SkillRegistry/命令表/HookExecutor/MCP
  配置可见对应贡献；disabled 插件不注册。

每轮完成 = `pnpm check-types` + `pnpm test` 全绿。
