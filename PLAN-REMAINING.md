# OpenHarness-ts — 补齐计划（对比 Python 原版 v0.1.9）

基于对 Python 原版 `openharness` **v0.1.9** 源码的逐模块审计整理。核心 harness（引擎 / 工具 / 权限 / 会话 / 前端协议）已可用，但相对原版仍有大量功能未对齐。本文档按**影响面 + 优先级**排序，给出可执行的补齐路线。

> 状态图例：✅ 基本对齐 · 🟡 可用但简化 · 🟠 骨架/部分 · 🔴 未实现 · ⛔ 不在复刻范围

> **进度（分支 `feat/align-phase-ab`）**：**Phase A、Phase B 已完成**（4 commit，`check-types` 26/26、`test` 25/25 全绿）。
> 遗留 TODO：① bash 在无 Git Bash 的 Windows 上的优雅降级。B.2 compact attachments、B.5 per-turn 记忆检索均已完成；Phase C/D 大部分已完成，见下表。

## 原则

1. 每步完成 = `pnpm check-types` 通过 + `pnpm test` 通过（pre-commit 与 CI 已接入）。
2. **先修正确性、再补能力、最后做大模块**：Phase A 不增功能只修 bug，Phase B/C 补核心与扩展，Phase D/E 做大模块与体验。
3. 每步可独立验证，不依赖后续步骤。
4. ⛔ 不在范围：`autopilot`（仓库级自动驾驶 + dashboard）、`voice`（STT/TTS）。

---

## 对齐总览

| 模块 | 状态 | 一句话差距 |
|------|------|-----------|
| api | 🟡 | ✅`<think>`过滤/图片传递/max_completion_tokens(A.1)；仍缺 Codex/Copilot client、reasoning effort、modelscope |
| tools | 🟡 | ✅bash/grep/glob 健壮性(A.3)；✅ImageToText(视觉 fallback)/ImageGeneration(DALL-E 兼容) |
| mcp | ✅ | stdio + HTTP(streamable)/SSE 传输 + headers 鉴权 + 失败隔离已补(C.3)；仅 MCP OAuth flow 待补 |
| engine/compact | ✅ | context collapse/PTL 重试/配对保护/图片占位/boundary/hooks/checkpoint/attachments 全部完成(B.2) |
| hooks | ✅ | priority/10 事件/prompt·agent/`$ARGUMENTS`+转义/matcher 已补(B.1) |
| memory | 🟡 | ✅frontmatter/加权搜索(distinct)/use_count/签名去重/MEMORY.md/中文分词(A.4+B.4)；仍缺团队隔离+密钥扫描(C) |
| prompts | 🟡 | ✅CLAUDE.md 向上遍历/permission-mode/delegation 段+per-turn 记忆检索(B.5)；personalization 段待 C |
| tasks | ✅ | 真实子进程执行/stdin/落盘/completion listener/断管重启/优雅关停(B.3) |
| coordinator | ✅ | ✅mode env(A.5)+用户/plugin agent 加载器+mode 辅助+CLI接线(C.4)；✅agent 级字段运行时生效(tools/disallowedTools/maxTurns/effort/permissionMode) |
| auth | 🟠 | 无 ProviderProfile 体系、无 keyring、明文凭证、无 copilot/codex OAuth |
| plugins | 🟡 | ✅skills/commands/hooks/MCP/agents/tools_dir 贡献+信任门控+卸载防护(C.1+C.4)；✅MCP connectAll+工具注册(REPL+BackendHost) |
| bridge | 🟡 | ✅spawn+stdout捕获+terminate/kill(D.4)；work-secret / SDK WS URL 不做（云端专用） |
| swarm | ✅ | 派发/TaskWait/worktree/只读放行+文件邮箱/team.json/权限同步+task-worker 多轮 sendMessage+重启上下文恢复(D.1)；缺 TUI 人工裁决 |
| channels | 🟠 | ~5%，仅 Feishu(未导出+bug)+Stdio+Http，缺 7+ 通道与附件/群组/桥接 |
| sandbox | 🔴 | 占位 stub，无 Docker backend |
| services(autodream/memory_extract/session_memory/tool_outputs) | 🟡 | ✅记忆四件套+/dream /remember+每轮 checkpoint(E.6 第一刀)；✅cron: command/timezone/daemon(E.6 第二刀)；缺 compact 读回接线、lsp 真 AST |
| personalization | ✅ | 10 类事实抽取+local_rules 持久化+prompt 注入+三模式 session-end 触发(C.5) |
| ohmo | 🔴 | 整应用缺失（个人助理 + 多渠道网关） |
| autopilot | ⛔ | 不复刻 |

---

## Phase A — 正确性修复（P0，不增功能）✅ 已完成

> 已在 `feat/align-phase-ab` 完成（commit `8a31413`）。A.1–A.5 全部实现并测试。

先把"看起来实现了但实际有 bug / 行为不对"的地方修对，影响面最广、成本最低。

### A.1 API 客户端正确性
- OpenAI 兼容流式补 `<think>` 块跨 chunk 过滤（对齐 `_strip_think_blocks`）。
- 图片消息转换：`convertMessages` 对非字符串 content 用 `JSON.stringify`，导致 ImageBlock 无法传给 OpenAI 端 → 转为 `image_url` data-uri。
- gpt-5 / o1 / o3 / o4 系列改用 `max_completion_tokens`（当前恒用 `max_tokens` 会报错）。
- reasoning_content 重放加 `OPENHARNESS_REQUIRE_EMPTY_REASONING_CONTENT` 开关（当前无条件发空 reasoning_content，严格端点会 400）。
- **文件**：`packages/api/src/providers/openai.ts`、`anthropic.ts`

### A.2 channels Feishu 修复
- `FeishuAdapter.send` 用 `message.id` 当 `receive_id`（疑似 bug）→ 用正确的会话 ID。
- `FeishuAdapter` 未在 `packages/channels/src/index.ts` 导出 → 导出。
- **文件**：`packages/channels/src/feishu.ts`、`index.ts`

### A.3 工具健壮性（对齐 v0.1.8 修复）
- grep/glob：ripgrep stderr 重定向到 DEVNULL（避免 pipe 填满阻塞）；超长行（>64KB）跳过而非崩溃；grep 加 `--hidden`。
- bash：超时后抓取 partial output；统一大输出截断（~12000 字符）。
- glob：尊重 `.gitignore`、跳过 `.venv`/重目录、支持 limit。
- **文件**：`packages/tools/src/search/grep.ts`、`glob.ts`、`shell/bash.ts`

### A.4 memory 中文检索
- 搜索分词支持 CJK 逐字（`一-鿿`），当前 `split(/\s+/)` 对中文整句视作一个 term。
- 搜索匹配 body 内容（不只 metadata）。
- **文件**：`packages/memory/src/index.ts`

### A.5 coordinator mode env 一致性
- `isCoordinatorMode()` 读取与原版一致的 `CLAUDE_CODE_COORDINATOR_MODE`（当前读的 env 名不一致）。
- **文件**：`packages/coordinator/src/index.ts`

---

## Phase B — 核心能力补齐（P1）✅ 已完成

> 已在 `feat/align-phase-ab` 完成（commit `998b1c7`、`46aa5e5`，审查修复 `8be7984`）。B.1–B.5 全部实现并测试。
> **遗留 TODO**：（已全部完成）

### B.1 Hooks 完整化
- 补 `priority` 字段 + 同事件内按 priority 降序稳定排序。
- 事件类型补齐到 10 种（新增 pre/post_compact、user_prompt_submit、notification、stop、subagent_stop）。
- 实现 prompt / agent 类型 hook（真正调模型返回 `{ok, reason}`）。
- `$ARGUMENTS` 注入 + shell 转义（防注入）；matcher（fnmatch）过滤；`OPENHARNESS_HOOK_EVENT/PAYLOAD` 环境变量。
- **文件**：`packages/hooks/src/index.ts`、`packages/core/src/types/hooks.ts`

### B.2 Compact 高级链路 ✅ 已完成
- ✅ context collapse（确定性折叠超长文本）、PTL（prompt-too-long）重试 + 头部截断、tool_use/result 配对保护、图片占位替换。
- ✅ boundary marker、PRE/POST_COMPACT hooks、progress/checkpoint。
- ✅ compact attachments（B.2 尾巴）：`extractRecentFiles()`（Read/Write/Edit tool_use 历史，最近 20）、`deriveWorkLog()`（工具调用计数摘要）、`buildCompactPrompt()`（拼入 `<context>` 段）；`setAttachmentsProvider()` 外部注入 taskFocus/plan；REPL + BackendHost 两处接线 TaskManager.listTasks("running") 提供 task_focus。
- **文件**：`packages/core/src/engine/compact-service.ts`、`packages/core/src/types/runtime.ts`、`packages/core/src/engine/query-engine.ts`、`apps/cli/src/commands/main.ts`

### B.3 Tasks 真实执行
- `TaskManager.createAgentTask` 真正拉起子进程（当前只建记录不执行）、stdin 流式写入、输出落盘 + tail。
- completion listener 注册/通知、agent 任务断管自动重启、优雅关停。
- **文件**：`packages/services/src/tasks/index.ts`

### B.4 Memory 模型升级
- Markdown + YAML frontmatter 格式（type/scope/importance/ttl/disabled/supersedes/signature）。
- 加权搜索（frontmatter×2 / body×1 + recency / importance / use_count）、使用次数索引、stale 候选挖掘。
- `MEMORY.md` 索引维护、content signature 去重、按项目(cwd) 隔离。
- **文件**：`packages/memory/src/index.ts`

### B.5 Prompts 上下文增强
- CLAUDE.md 从 cwd **向上逐级遍历**累积（含 `.claude/CLAUDE.md`、`.claude/rules/*.md`）。
- 相关记忆检索（select_relevant_memories + mark_memory_used）注入。
- permission-mode 段、delegation/subagent 段。
- **文件**：`packages/prompts/src/index.ts`

> B.5 per-turn 相关记忆检索已于后续完成：`QueryEngine.memoryRetriever` 回调 + `composeTurnSystemPrompt()` 瞬态注入，REPL 和 BackendHost 两路均接线。B.5 全部完成。

---

## Phase C — 扩展层补齐（P2）

### C.1 Plugins 贡献加载 ✅ 完成
- ✅ skills / commands / hooks / MCP 四类贡献加载与注册（Claude Code 布局兼容：
  `.claude-plugin/` 备用路径、SKILL.md 目录式、结构化 hooks.json、`.mcp.json`、
  `${CLAUDE_PLUGIN_ROOT}` 替换）；`/plugin:cmd` 斜杠路由复用 skill 链路。
- ✅ project 信任门控（allowProjectPlugins，默认禁）+ 卸载路径穿越防护。
- ✅ plugin agents 已随 C.4 收口（`packages/plugins/src/agents.ts`）。
- ✅ `tools_dir` 动态 import（`registerPluginTools`，二段注册在 bootstrap 后，
  REPL/BackendHost/task-worker 三路均接线；default export ToolDefinition | ToolDefinition[]）。
- ✅ BackendHost MCP 已修：补 `connectAll` + `getAsToolDefinitions()` 注册 + `setMcpManager()` 注入 ToolContext，REPL 和 BackendHost 均生效。
- **文件**：`packages/plugins/src/{discovery,contributions,hooks-mcp}.ts`、`apps/cli/src/plugin-contributions.ts`

### C.2 Auth ProviderProfile 体系
- 命名 ProviderProfile（list/use/add/edit/remove/switch；base_url/api_format/model/credential_slot 等字段）。
- 凭证存储支持系统 keyring + 文件回退（0o600 权限），与 settings 联动。
- auth source 多源状态探测（env/file/keyring/external）。
- **文件**：`packages/auth/src/index.ts`、`credential-storage.ts`

### C.3 MCP HTTP/SSE 传输 ✅ 已完成
- ✅ streamable-http / SSE 传输；HTTP headers 鉴权 + `authConfigured` 追踪；失败隔离保持。
- ✅ resources 区分 "Method not found" 与真实错误。
- 留待：`updateServerConfig`/`getServerConfig` 运行时改配置、MCP OAuth flow。
- **文件**：`packages/mcp/src/index.ts`、`packages/core/src/types/settings.ts`（commit `1a18988`）

### C.4 Coordinator 加载与 prompt 还原 ✅ 完成
- ✅ 用户 `.md` agent 加载器（真 YAML frontmatter + 行级回退，~20 字段）；
  `getAllAgentDefinitions` 三源合并 builtin < user < plugin。
- ✅ plugin agents（`plugin:ns:name` 命名，hooks/mcpServers/omitClaudeMd 信任面剥除）。
- ✅ coordinator system prompt 经核对本就全量（「大幅精简」描述过时）；补
  `CLAUDE_CODE_SIMPLE` 简单模式分支、`matchSessionMode`、`getCoordinatorTools`、
  `getCoordinatorUserContext`（scratchpad/worker-tools 注入）。
- ✅ CLI 接线：session 快照存 `session_mode`；`--continue/--resume` 恢复时调
  `matchSessionMode` 自动同步 env；REPL/BackendHost 启动时若 coordinator 模式
  调 `queryEngine.setAllowedTools(getCoordinatorTools())`（Agent/SendMessage/TaskStop）。
- `QueryEngine.setAllowedTools(string[]|null)`：在 submitMessage 内 streamMessage
  调用前过滤 toolRegistry，null 解除限制。
- ✅ agent 级字段运行时生效：`tools/disallowedTools/maxTurns/effort/permissionMode` 经 `TeammateSpawnConfig` → `buildTeammateCommand` → CLI argv 传给子进程，bootstrap 应用。留待：agent 级 `hooks/mcpServers` 的运行时生效（需 env var 传 JSON，较复杂）。
- **文件**：`packages/coordinator/src/{agent-loader,coordinator-mode}.ts`、`packages/plugins/src/agents.ts`、`packages/core/src/{types/runtime,engine/query-engine}.ts`、`packages/services/src/session/storage.ts`、`apps/cli/src/commands/main.ts`

### C.5 Personalization（新模块）✅ 已完成
- ✅ `packages/personalization`：10 类环境事实正则抽取（SSH/IP/数据路径/conda/
  Python/端点/env/git remote/Ray/cron），去重合并 + 置信度胜出。
- ✅ `local_rules/` rules.md + facts.json 持久化（尊重 OPENHARNESS_CONFIG_DIR）。
- ✅ 三模式结束路径 best-effort 抽取；rules.md 注入 system prompt（CLAUDE.md 后）。
- 顺带修了 Python git_remote 正则的失效模式（恒捕获 1 字符被过滤）。
- **文件**：`packages/personalization/src/index.ts`、`packages/prompts/src/index.ts`

---

## Phase D — 大模块（P3）

### D.1 Swarm 真实派发 ✅ 完成（D.1–D.5 + 重启上下文恢复）
- ✅ `subprocess` 后端（spawn → 后台子进程 → TaskWait 取结果，swarm D.1/D.2）。
- ✅ 文件式邮箱（每消息一文件 + `.tmp`+rename 原子写 + wx 锁文件，D.5-R1）。
- ✅ 权限同步（read-only 自动批准 D.4；pending/resolved 文件流 + leader/worker 检测 +
  **worker 写操作转 leader checker 自动裁决**——接线超出 Python 原版，见
  `docs/swarm-file-infra-design.md` 差异表，D.5-R3）。
- ✅ 团队磁盘持久化 `team.json`（D.5-R2）、git worktree 隔离（D.3）。
- ✅ 多轮 `sendMessage`（task-worker 重启式，对齐 Python）。
- ✅ 重启上下文恢复：Agent 工具预生成 `sessionId` → `TeammateSpawnConfig.sessionId`
  → `--session-id <id>` → task-worker 启动时 `loadSessionById` 加载快照注入引擎；
  每轮结束后 `saveSessionSnapshot` 持久化，下次重启无缝续接。team.json 也记录 sessionId。
- 留待：`ask` 时 TUI 弹框人工裁决（当前 checker 自动）。
- **文件**：`packages/swarm/src/{lockfile,mailbox,team-lifecycle,permission-sync,index}.ts`、`packages/tools/src/agent/index.ts`、`apps/cli/src/teammate.ts`、`apps/cli/src/index.ts`、`apps/cli/src/commands/main.ts`、`apps/cli/src/runtime.ts`

### D.2 Channels 多通道 + 引擎桥接
- ✅ 基座：`MessageBus`（双异步队列，AbortSignal 退出）、ACL（fail-closed：
  空全拒/`"*"`全放/`"|"`分段）、`ChannelManager`（注入式 adapter、启停/出站
  分发、单通道失败不拖垮）、`ChannelBridge`（inbound → `engine.submitMessage`
  聚合 text_delta → outbound）。
- ✅ 接线（TS 自有，Python 侧是 ohmo 消费的库）：`ohs channels serve|status`
  长驻模式 + `settings.channels` 配置段；飞书基础版（文本收发 + @bot 过滤，
  ACL 上移 manager）。微信不做（用户裁决，Python 本无）。serve 无头模式
  只读工具自动放行（写/Bash 仍拒）；`settings.permission.autoApproveTools`
  顺带接线。详见 `docs/channels-bridge-design.md`。
- 留待：Telegram/Discord/Slack 等其余通道、媒体收发、长消息分片、飞书消息
  去重 + bot 消息跳过、线程级会话隔离。
- **文件**：`packages/channels/src/`、`apps/cli/src/commands/channels.ts`

### D.3 Sandbox Docker backend
- 实现 Docker backend：`docker run` + 资源限制（`--cpus`/`--memory`）+ 网络隔离（`--network none` + allowed/denied_domains fail-closed）+ 镜像管理 + path validator。
- 接入 bash 工具的 sandbox 执行路径。
- **文件**：`packages/sandbox/src/index.ts`

### D.4 Bridge 多进程会话（按需）
- ✅ `spawn(command, cwd)`：`child_process.spawn(shell:true)`，stdout+stderr 并行泵入 `~/.openharness/bridge/logs/<id>.log`。
- ✅ `stop(sessionId)`：SIGTERM → 3s 超时 → SIGKILL，对齐 Python `SessionHandle.kill()`。
- ✅ `listSpawnedSessions()`：返回 `BridgeSessionRecord`（pid / status / outputPath），按启动时间倒序。
- ✅ `readOutput(sessionId, maxBytes=12000)`：读末尾日志，对齐 Python `read_output()`。
- ✅ `getBridgeManager()` 单例导出。
- 留待：work-secret 编解码 + SDK WS URL 构造（云端专用，按需）。
- **文件**：`packages/bridge/src/index.ts`

---

## Phase E — CLI / TUI 体验 + 订阅 Provider（P4）

### E.1 CLI 子命令补齐 ✅ 已完成（最小版）
- ✅ `oh setup` 首次引导向导；`oh provider`（list/use/add/edit/remove，含 `--api-key`）。最小版：settings.provider + credentials key，**不做**命名 ProviderProfile/keyring（C.2）。
- ✅ `oh --dry-run` 安全预览（model/provider/key 来源/有效 baseURL/工具数/skills/MCP/readiness）。
- 留待：auth switch / copilot-login / codex-login（OAuth 订阅属 E.4）。
- 顺带修：`ANTHROPIC_BASE_URL` 污染通用 baseUrl（dry-run 实测发现，commit `f6fed64`）。
- **文件**：`apps/cli/src/commands/provider.ts`、`setup.ts`、`apps/cli/src/dry-run.ts`

### E.2 缺失斜杠命令
- ✅ 高价值批次：`/stats`（messages/tokens/tools/memory/tasks/output_style）、
  `/reload-plugins`（先清后注册，disable 立即生效）、`/subagents`（三源人格列表；
  差异：Python 为任务视图，TS 由既有 `/agents` 覆盖）、`/plugin list|enable|disable`
  （持久化 settings.plugins；install/uninstall 不做——无插件市场）。
  顺带修：`getUserPluginsDir` 尊重 `OPENHARNESS_CONFIG_DIR`。
- `/export` `/agents` `/output-style` 此前已有；skill 作 `/<skill>` 已随 E.5 落地。
- 留待：`/keybindings` `/vim` `/passes` `/release-notes` `/login` `/logout` 等低频项（按需）。
- **文件**：`apps/cli/src/commands/slash-commands.ts`、`packages/plugins/src/discovery.ts`

### E.3 TUI 渲染
- ✅ **Edit/Write unified diff 预览**（approve once / session / full_auto 自动跳过）——
  改文件前在 TUI 权限框显示 +/− 着色 diff，`[y]` 本次 / `[a]` 整个会话(按工具名) / `[n]` 拒绝。
  仅 TUI（REPL/print 无交互权限确认）。详见 `docs/permission-flow.md`。
- ✅ **Output styles**（输出样式,忠实复刻 v0.1.9）——`default/minimal/codex` 三内置 +
  用户 `~/.openharness/output_styles/*.md`;REPL `EventRenderer` 按 name 分支(`minimal` 极简纯文本);
  `/output-style [show|list|NAME]` 命令(REPL 热切换+持久化);TUI render-branch 已随
  E.3 收口补齐。详见 `docs/output-styles-design.md`。
- ✅ 语法高亮（cli-highlight，无 lang 不 auto-detect）、TUI output-style
  render-branch（minimal 极简工具行 + /output-style 热切换）、tool 行分组
  折叠（最新组展开，旧组摘要行）——E.3 全部收口，详见 `docs/tui-render-tail-design.md`。
- **文件**：`packages/tools/src/file/{preview,diff}.ts`、`packages/output-styles/src/index.ts`、`apps/cli/src/renderer.ts`、`apps/cli/src/commands/{main,slash-commands}.ts`、`apps/frontend/src/components/ModalHost.tsx`、`apps/frontend/src/App.tsx`

### E.4 订阅 Provider（按需）
- Codex client（chatgpt.com Responses API + reasoning effort `xhigh`）；Copilot client（OAuth device flow + token 持久化）。
- vision/multimodal 检测 + image_to_text fallback 工具；`--vision-model` 覆盖。
- 补 modelscope provider profile。
- **文件**：`packages/api/src/providers/`、`packages/tools/src/`

### E.5 Skills 增强 ✅ 完成
- ✅ frontmatter 补 user-invocable / disable-model-invocation / model / argument-hint。
- ✅ 内置 bundled skills（commit/review/test/plan/debug，TS 内嵌）；user/project 多源（bundled<user<project）+ 同名覆盖。
- ✅ user-invocable skill 作 `/<skill>` 斜杠命令（REPL + backend；内置命令优先）；model 可见性过滤（disable-model-invocation 不进 system prompt，三模式一致）。
- ✅ project skills **git-root 向上逐级遍历**：`findProjectSkillDirs(cwd)` 从 cwd 走到 `.git` 根，每层各收 `.openharness/skills` + `.claude/skills`，root→cwd 顺序加载（cwd 层最高优先）。
- ✅ **路径穿越防护**：`discoverMarkdownFiles` 用 `resolve + sep` 校验每个文件的绝对路径必须在 `dirPath` 内（防 symlink/`..` 逃逸）。
- ✅ **每命令 model 覆盖**：`/<skill>` 调用时若 `skill.model` 非空，在 `submitMessage` 前
  临时 `setModel(skill.model)`，finally 块恢复原 model（REPL + BackendHost 两路均接线）。
- 留待：skill-creator/diagnose 重工作流 skill。
- **文件**：`packages/skills/src/index.ts`、`apps/cli/src/commands/main.ts`

### E.6 Services 杂项
- ✅ 记忆四件套（第一刀）：`autodream`（/dream 命令+锁/备份/回滚）、`memory_extract`
  （/remember 命令）、`session_memory`（REPL 每轮 checkpoint）、`tool_outputs`
  （预算函数）。留待：compact 侧读回 checkpoint、tool_outputs 接 microcompact、
  executeAutoDream 自动触发（归 cron）。详见 `docs/services-memory-quartet-design.md`。
- ✅ cron 调度升级（第一刀）：`CronScheduler.start()` 改为 `setTimeout` 自重调度，
  每次触发后用 `computeNextRunTime()` 精确计算下一次绝对时刻，替代近似 `setInterval`。
- ✅ cron 升级（第二刀）：
  - `command` 字段接线：触发时 `execAsync()` 运行 shell 命令（5 min 超时，输出写日志）。
  - 时区支持：`CronJob.timezone`（IANA 名），`computeNextRunTime(expr, base?, tz?)` 用
    `Intl.DateTimeFormat + hourCycle:'h23'` 按时区计算触发时刻；无效 tz 安全回退本地。
  - 独立守护进程：`saveJobs`/`loadJobs` 持久化 job 定义；`ohs cron add/remove/daemon`；
    `ohs cron start` spawn detached daemon + PID 文件；`ohs cron stop` 按 PID 发 SIGTERM。
  留待：通知回调（job 完成后 webhook/channel 通知）。
- ✅ session 存储（第二刀）：cwd 哈希分目录 + latest/id 双写 + load 侧配对修复 +
  Markdown 导出；--continue/--resume 已接线（裸 continue 不串项目）。
- ✅ toolMetadata 投喂：`saveSessionSnapshot()` 传入 `engine.getToolMetadata?.()` 。
- ✅ Ctrl+C 保存：REPL `rl.on("close")` 退出前 `await saveSessionSnapshot`。
- ✅ `/export` 命令：`/export [filename] [--json]`，文件名 `.json` 后缀或 `--json` 标志
  输出结构化 JSON（session_id/model/exported_at/messages），否则输出 Markdown；
  默认写入 `~/.openharness/data/exports/`。
- 留待：compact 侧读回 checkpoint、tool_outputs 接 microcompact。
  详见 `docs/session-storage-design.md`。
- lsp 用真实 AST 解析（当前为正则/rg 近似）。

---

## 执行顺序建议

```
Phase A (正确性)   → 最高优先，低成本，立即提升可用性
Phase B (核心)     → 引擎/工具/记忆/prompt 能力，影响上层
Phase C (扩展)     → 插件/auth/mcp/coordinator/personalization
Phase D (大模块)   → swarm/channels/sandbox（工作量大，可挑选）
Phase E (体验)     → CLI/TUI/订阅 provider，可与 C/D 并行
```

> ⛔ 明确不做：`autopilot`、`voice`。`ohmo` 视为可选的上层应用（依赖 channels 网关成熟后再评估）。
