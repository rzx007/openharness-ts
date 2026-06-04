# OpenHarness-ts — 补齐计划（对比 Python 原版 v0.1.9）

基于对 Python 原版 `openharness` **v0.1.9** 源码的逐模块审计整理。核心 harness（引擎 / 工具 / 权限 / 会话 / 前端协议）已可用，但相对原版仍有大量功能未对齐。本文档按**影响面 + 优先级**排序，给出可执行的补齐路线。

> 状态图例：✅ 基本对齐 · 🟡 可用但简化 · 🟠 骨架/部分 · 🔴 未实现 · ⛔ 不在复刻范围

## 原则

1. 每步完成 = `pnpm check-types` 通过 + `pnpm test` 通过（pre-commit 与 CI 已接入）。
2. **先修正确性、再补能力、最后做大模块**：Phase A 不增功能只修 bug，Phase B/C 补核心与扩展，Phase D/E 做大模块与体验。
3. 每步可独立验证，不依赖后续步骤。
4. ⛔ 不在范围：`autopilot`（仓库级自动驾驶 + dashboard）、`voice`（STT/TTS）。

---

## 对齐总览

| 模块 | 状态 | 一句话差距 |
|------|------|-----------|
| api | 🟡 | 缺 Codex/Copilot client、reasoning effort、`<think>` 过滤、vision/图片传递、modelscope |
| tools | 🟡 | 缺 image_to_text/image_generation；bash/grep/glob 大幅简化 |
| mcp | 🟡 | 仅 stdio，无 HTTP/SSE 传输与 headers 鉴权 |
| engine/compact | 🟡 | 缺 context collapse、PTL 重试、compact attachments、hooks/checkpoint |
| hooks | 🟡 | prompt/agent 空实现、无 priority、事件仅 4/10、无 `$ARGUMENTS`/matcher |
| memory | 🟡 | 无 frontmatter/分类、无加权搜索、无使用索引、无团队隔离、**无中文分词** |
| prompts | 🟡 | CLAUDE.md 不向上遍历、无相关记忆检索、无 personalization/permission-mode 段 |
| coordinator | 🟡 | system prompt 精简、无用户/plugin agent 加载、编排仅声明 |
| auth | 🟠 | 无 ProviderProfile 体系、无 keyring、明文凭证、无 copilot/codex OAuth |
| plugins | 🟠 | 仅读 plugin.json，无 tools_dir 发现 / commands/agents/hooks 贡献加载 |
| bridge | 🟠 | 仅会话元数据登记，无多进程 spawn / 输出捕获 / work-secret |
| swarm | 🟠 | ~4%，无真实派发后端、文件邮箱、权限同步、团队持久化、worktree 隔离 |
| channels | 🟠 | ~5%，仅 Feishu(未导出+bug)+Stdio+Http，缺 7+ 通道与附件/群组/桥接 |
| sandbox | 🔴 | 占位 stub，无 Docker backend |
| services(autodream/memory_extract/session_memory/tool_outputs) | 🔴 | 整体缺失 |
| personalization | 🔴 | 整模块缺失（环境事实抽取） |
| ohmo | 🔴 | 整应用缺失（个人助理 + 多渠道网关） |
| autopilot | ⛔ | 不复刻 |

---

## Phase A — 正确性修复（P0，不增功能）

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

## Phase B — 核心能力补齐（P1）

### B.1 Hooks 完整化
- 补 `priority` 字段 + 同事件内按 priority 降序稳定排序。
- 事件类型补齐到 10 种（新增 pre/post_compact、user_prompt_submit、notification、stop、subagent_stop）。
- 实现 prompt / agent 类型 hook（真正调模型返回 `{ok, reason}`）。
- `$ARGUMENTS` 注入 + shell 转义（防注入）；matcher（fnmatch）过滤；`OPENHARNESS_HOOK_EVENT/PAYLOAD` 环境变量。
- **文件**：`packages/hooks/src/index.ts`、`packages/core/src/types/hooks.ts`

### B.2 Compact 高级链路
- context collapse（确定性折叠超长文本）、PTL（prompt-too-long）重试 + 头部截断、tool_use/result 配对保护、图片占位替换。
- compact attachments（task_focus / recent_files / plan / work_log 等）、boundary marker、PRE/POST_COMPACT hooks、progress/checkpoint。
- **文件**：`packages/core/src/engine/compact-service.ts`

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

---

## Phase C — 扩展层补齐（P2）

### C.1 Plugins 贡献加载
- `tools_dir` 工具自动发现并实例化注册。
- commands / agents / hooks / MCP 贡献加载；`.claude-plugin/` 备用路径；`${CLAUDE_PLUGIN_ROOT}` 替换。
- project 信任门控 + 路径穿越防护（卸载时拒绝 `..`/绝对路径）。
- **文件**：`packages/plugins/src/index.ts`

### C.2 Auth ProviderProfile 体系
- 命名 ProviderProfile（list/use/add/edit/remove/switch；base_url/api_format/model/credential_slot 等字段）。
- 凭证存储支持系统 keyring + 文件回退（0o600 权限），与 settings 联动。
- auth source 多源状态探测（env/file/keyring/external）。
- **文件**：`packages/auth/src/index.ts`、`credential-storage.ts`

### C.3 MCP HTTP/SSE 传输
- 增加 streamable-http / SSE 传输；HTTP headers 鉴权 + `auth_configured` 追踪。
- resources 区分 "Method not found" 与真实错误；`updateServerConfig`/`getServerConfig`。
- **文件**：`packages/mcp/src/index.ts`

### C.4 Coordinator 加载与 prompt 还原
- 用户 `.md` agent 加载器（YAML frontmatter）+ plugin agent 合并。
- 还原 coordinator / verification system prompt 的完整行为约束（当前大幅精简）。
- scratchpad / worker-tools 上下文注入、`match_session_mode` 会话对齐。
- **文件**：`packages/coordinator/src/`

### C.5 Personalization（新模块）
- 新建 `packages/personalization`：会话历史正则抽取环境事实（SSH/IP/conda/端点/env/git remote 等）。
- `~/.openharness/local_rules/` 下 rules.md + facts.json 持久化 + 去重合并。
- session-end 钩子触发，结果注入 system prompt。
- **依赖**：B.5（prompts 注入）、B.1（session_end hook）

---

## Phase D — 大模块（P3）

### D.1 Swarm 真实派发
- 至少实现 `subprocess` 后端（对齐 spawn_utils：继承 CLI flags + env var，`shlex.quote` 防注入）。
- 文件式邮箱（原子写 + 文件锁，进程间可用）替换内存队列。
- 权限同步（read-only 工具自动批准、permission request/response 文件流、leader/worker 检测）。
- 团队磁盘持久化 `team.json`、git worktree 隔离。
- **文件**：`packages/swarm/src/`、依赖 B.3（BackgroundTaskManager）

### D.2 Channels 多通道 + 引擎桥接
- 基座：`BaseChannel`（统一 ACL）、`ChannelManager`（启停/出站分发）、`MessageBus`（inbound/outbound 双队列）、`ChannelBridge`（接入 QueryEngine 并回传）。
- 通道：优先 Telegram / Discord / Slack；附件/媒体收发、群组/线程路由、命令系统、长消息分片、Markdown 渲染。
- **文件**：`packages/channels/src/`

### D.3 Sandbox Docker backend
- 实现 Docker backend：`docker run` + 资源限制（`--cpus`/`--memory`）+ 网络隔离（`--network none` + allowed/denied_domains fail-closed）+ 镜像管理 + path validator。
- 接入 bash 工具的 sandbox 执行路径。
- **文件**：`packages/sandbox/src/index.ts`

### D.4 Bridge 多进程会话（按需）
- 多进程会话 spawn + stdout 捕获到日志 + kill/terminate；work-secret 编解码 + SDK WS URL 构造。
- **文件**：`packages/bridge/src/index.ts`

---

## Phase E — CLI / TUI 体验 + 订阅 Provider（P4）

### E.1 CLI 子命令补齐
- `oh setup` 首次引导向导；`oh provider`（list/use/add/edit/remove，含 `--api-key` 更新，对齐 v0.1.9）。
- `oh --dry-run` 安全预览（resolved settings / auth / prompt / commands / skills / tools / MCP，readiness verdict）。
- auth 子命令补 switch / copilot-login / codex-login。
- **文件**：`apps/cli/src/commands/`、`apps/cli/src/index.ts`

### E.2 缺失斜杠命令
- 补齐 `/stats` `/output-style` `/keybindings` `/vim` `/passes` `/release-notes` `/subagents` `/login` `/logout` `/reload-plugins` `/plugin` 等（按需，约 30 个）。
- 用户可调用 skill 作为 `/<skill>` 斜杠命令（对齐 v0.1.9）。
- **文件**：`apps/cli/src/commands/slash-commands.ts`

### E.3 TUI 渲染
- 引入 markdown 渲染（标题/列表/代码块/表格）+ 语法高亮；edit/write 的 unified diff 预览（approve once / session / full_auto 自动跳过）。
- codex output style（紧凑低噪）；tool 行分组折叠。
- **文件**：`apps/frontend/src/components/`、`packages/output-styles`

### E.4 订阅 Provider（按需）
- Codex client（chatgpt.com Responses API + reasoning effort `xhigh`）；Copilot client（OAuth device flow + token 持久化）。
- vision/multimodal 检测 + image_to_text fallback 工具；`--vision-model` 覆盖。
- 补 modelscope provider profile。
- **文件**：`packages/api/src/providers/`、`packages/tools/src/`

### E.5 Skills 增强
- frontmatter 补 user-invocable / disable-model-invocation / model / argument-hint。
- 内置 bundled skills（skill-creator / diagnose 等）；user/project/plugin 多源 + 向上遍历 + 覆盖优先级 + 信任门控。
- 布局对齐 `<dir>/SKILL.md` 约定。
- **文件**：`packages/skills/src/`

### E.6 Services 杂项
- 新增 `autodream`（记忆梦境整合）、`memory_extract`（对话提取 durable 记忆）、`session_memory`（checkpoint）、`tool_outputs`（microcompactable 判定）。
- cron 升级到 croniter 级表达式 + 时区 + 独立调度守护进程 + 子进程执行 + 通知。
- session 存储补 cwd 哈希分目录 + latest/id 双写 + tool_metadata 持久化 + Markdown 导出。
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
