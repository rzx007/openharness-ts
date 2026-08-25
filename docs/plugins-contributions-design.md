# Plugin 贡献加载

> 状态：待替换的当前实现。本文只描述仓库现在仍在运行的临时格式，不再代表下一版公开插件契约。已确认的破坏性替换方案见 [OpenHarness 原生插件与外部转换器设计](./superpowers/specs/2026-08-25-native-plugin-and-converters-design.md)：Runtime 只加载版本化的 OpenHarness Native Plugin；Claude Code、Codex 等外部插件由独立 Converter 在安装阶段转换，不兼容本文的 snake_case manifest、根级 `plugin.json` 和 `tools_dir`。

## 范围

当前范围：发现、信任门控、skills/commands/hooks/MCP/agents/tools 六类贡献、`${CLAUDE_PLUGIN_ROOT}` 和卸载路径穿越防护。

bundled plugins 当前没有内置目录；用户插件和受信任的项目插件走同一套加载规则。

`tools_dir` 动态 import 工具：`registerPluginTools` 遍历 `<plugin>/<tools_dir>/*.js|ts`，验证 `name` 与 `execute` 后注册进当前 runtime 的 `toolRegistry`；单个工具 import 失败只产生告警，不阻止其他贡献加载。

## 支持的插件布局

目录位置和多数贡献文件沿用 Claude Code 的插件布局，但 OpenHarness 只接受自己的当前严格字段。尤其 MCP server 必须显式写 `type`，不能把缺少当前字段的旧插件目录直接视为有效配置。

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
~/.openharness-ts/plugins/<name>/       # 用户插件（默认加载）
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
  agents?: string | string[];
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
  mcpServers: Record<string, McpServerConfig>;
  agents: AgentDefinition[];
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
  插件不覆盖。每个 server 必须显式写 `type` 和对应的 `command` 或 `url`。
- **agents**：递归读取 `agents/**/*.md` 和 manifest 指定路径，解析 frontmatter，使用插件名前缀生成稳定名字，再进入 runtime 的 agent definitions。
- **tools**：读取 `tools_dir` 中的 `.js`/`.ts` 模块，只有同时提供合法 `name` 与 `execute` 的模块才注册。
- **installer 防护**：`install`/`uninstall` 校验插件名（`[A-Za-z0-9._@-]+`，
  拒绝 `..`/路径分隔符/绝对路径）——字符集白名单本身已排除一切穿越构造，
  无需额外 resolve 断言（对齐 PLAN-REMAINING 的「卸载时拒绝 `..`/绝对路径」）。

## 与 Python 差异

| 点 | Python | TS | 原因 |
|----|--------|----|------|
| 发现目录 mkdir | `get_user_plugins_dir` 等读路径也 mkdir | 发现走纯路径计算，不建目录 | 避免查询留空目录（swarm D.5 的同类教训） |
| agents / tools 贡献 | loader 里有 | agents 与 tools 均加载 | agents 去掉不允许由插件扩大的 hooks/MCP 等字段；tools 经过导出形状校验 |
| YAML frontmatter | PyYAML safe_load | 复用 skills 包现有解析 | 不引新依赖 |
| 贡献消费 | cli.py/registry/mcp config 多点合并 | agent-runtime 按 cwd 发现并组装，CLI 管理命令复用相同 loader | daemon 中不同项目不会共享错误的 cwd 缓存 |
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
- 接线：临时插件目录端到端——load 后 SkillRegistry/命令表/HookExecutor/MCP、agents 和 tools 可见对应贡献；disabled 插件不注册。
