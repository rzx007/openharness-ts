# 记忆系统总览

OpenHarness 的"记忆"不是单一模块，而是**四层互补体系**。每层解决不同的问题：

```
问题                     解决方案             作用域
────────────────────────────────────────────────────
单轮工具输出太大？  →  tool_outputs 预算判定   本轮之内
会话被压缩后忘事？  →  session_memory 检查点   本次会话
有些事情要记很久？  →  持久记忆 + /remember   跨会话
记忆积久变乱？      →  /dream 梦境整合         定期维护
```

---

## 一图看清四层

```
┌──────────────────────────────────────────────────────────────────┐
│  每轮对话                                                         │
│  ┌─────────────────────────────┐                                  │
│  │  工具调用产生输出            │                                  │
│  │    ≤ 16k chars → 内联      │ ← tool_outputs 预算判定           │
│  │    > 16k chars → 截断+预览  │   (纯内存计算，不写盘)            │
│  └───────────────┬─────────────┘                                  │
│                  ↓                                                │
│  ┌─────────────────────────────┐                                  │
│  │  session_memory 写 checkpoint│ ← 每轮自动，原子写               │
│  │  goal / next_step / 摘要    │   ~/.openharness/data/           │
│  │  （最多 12k 字符 / 80 行）  │   session-memory/<项目>/<id>.md  │
│  └─────────────────────────────┘                                  │
└──────────────────────────────────────────────────────────────────┘
         ↓ 会话结束时                    ↓ 用户手动触发
┌────────────────────┐         ┌──────────────────────────┐
│  personalization   │         │  /remember               │
│  正则抽环境事实     │         │  LLM 提取语义事实         │
│  IP/路径/conda/…   │         │  决策/偏好/约束…          │
│  → facts.json      │         │  → memory/ 目录           │
│  → rules.md        │         │    (Markdown + frontmatter)│
│  → 下次自动注入    │         │                          │
│    system prompt   │         │                          │
└────────────────────┘         └──────────────────────────┘
                                         ↓ 积累一段时间后
                               ┌──────────────────────────┐
                               │  /dream                  │
                               │  后台子进程整理 memory/   │
                               │  合并重复 / 纠错矛盾 /   │
                               │  相对日期→绝对 / 重建索引 │
                               │  ⚠ 跑前整目录备份        │
                               └──────────────────────────┘
```

---

## 各层详解

### 层 1 · tool_outputs 预算判定（轮内，不写盘）

工具输出太长会撑爆单轮上下文，靠三个阈值控制：

| 阈值 | 默认值 | 含义 |
|------|--------|------|
| `inline` | 16 000 字符 | 低于此值 → 工具结果整段内联进上下文 |
| `preview` | 3 000 字符 | 超出 inline → 截断保留前 3k 作预览 |
| `microcompact` | 4 000 字符 | 老工具结果超此值 → 可被微压缩清理 |

可用环境变量覆盖：`OPENHARNESS_TOOL_OUTPUT_INLINE_CHARS` 等。

> 状态：✅ 已实现。工具结果写入 messages 前经 `applyToolOutputBudget` 截断（`query-engine.ts`）；microCompact 已扩展支持 MCP 工具（`compact-service.ts`）。阈值均可环境变量覆盖。

---

### 层 2 · session_memory 检查点（本次会话）

**解决什么问题**：`/compact` 会把历史消息全部压缩成一段摘要，模型压缩后就不知道"当前在做什么任务、下一步是什么"了。session-memory 的作用是在压缩边界把任务状态**注回上下文**，让模型不失忆。

**设计意图（完整流程）**：

```
压缩前：
  [消息1][消息2]...[消息100]   ← 上下文快满了

执行 /compact 之后（设计中）：
  [摘要：整段对话做了什么]
  [session-memory: 当前目标/下一步/关键状态]  ← 从文件读回来补上

效果：即使原始对话被替换，模型仍然知道自己在做什么
```

**写什么**：每轮结束自动将以下内容写入一个 Markdown 文件：
- 当前目标（`task_focus_state.goal`）
- 下一步（`task_focus_state.next_step`）
- 最近 80 行消息的文本摘要

**文件位置**：
```
~/.openharness/data/session-memory/
  <项目名>-<sha1前12>/
    <sessionId>.md
```

**示例文件内容**：
```markdown
# Session Memory

## Current State
正在修复 TUI 权限弹窗死锁问题

## Next Step
验证 readline handler 中 permission_response 的处理是否正确

## Recent Work
...（最近消息的文字摘要）
```

> **当前实现状态：✅ 已完整接线。**
> - 写入：REPL 和 TUI 模式每轮结束后自动写（print 模式不写）
> - 读回：`/compact` 和 autocompact 触发时，通过 `setAttachmentsProvider` 读取 checkpoint，注入摘要 prompt 的 `## Session Memory Checkpoint` 段落

---

### 层 3a · personalization 环境事实（跨会话，自动）

**解决什么问题**：你提到的服务器 IP、conda 环境、数据路径这类机械事实，每次都要重新说。

**原理**：**用户主动退出**（Ctrl+C / `/exit` / TUI 关闭）时，用 10 个正则扫描全部对话内容，识别：
- SSH 主机 / 服务器 IP
- 数据路径（`/data/`、`/mnt/` 等开头）
- conda 环境名（`conda activate xxx`）
- Python 版本、API 端点、环境变量
- git 远端、Ray 集群地址、cron 表达式

**写哪里**（全局，跨项目共享）：
```
~/.openharness/local_rules/
  facts.json     ← 结构化事实（按 type:value 去重）
  rules.md       ← 人类可读的摘要，下次启动注入 system prompt
```

**效果**：下次启动时，`rules.md` 自动出现在 system prompt 里，不用你再说"测试服在 10.0.0.7"。

> ⚠️ **对话进行中看不到文件是正常的**——退出会话后才写入。Python 原版也是同样设计。

> 状态：✅ 已实现（REPL/print/TUI 三模式退出时均自动触发）。

---

### 层 3b · 持久记忆 `/remember`（跨会话，手动）

**解决什么问题**：personalization 只抓正则能匹配的机械事实；"我们决定不做 X 因为 Y"、"这个项目偏好方案 Z"这类**语义事实**需要 LLM 来理解。

**触发方式**：你手动敲 `/remember`

**原理**：
1. LLM 读取本次会话，找出「值得长期保存、无法从代码/git 推导」的事实（每次 ≤3 条）
2. 写进 `memory/` 目录（Markdown + YAML frontmatter 格式，带签名去重）
3. 下次会话启动，相关记忆按轮检索注入 prompt

**内置护栏**：提取 prompt 里写死：不存密钥/令牌、只存稳定且不可推导的事实。

> 状态：✅ `/remember` 手动触发已实现；⏳ 按轮自动触发留待。

---

### 层 4 · `/dream` 梦境整合（定期维护）

**解决什么问题**：memory 目录积累久了会有重复条目、相互矛盾的内容、写着"明天"但已经是两年前的相对日期。

**触发方式**：你手动敲 `/dream`（或 `/dream --preview` 只看方案不执行）

**原理**：
1. 整目录备份（`~/.openharness/data/memory-backups/`）
2. 抢整合锁（防止并发两次 dream）
3. 拉起一个 `ohs --print <整合 prompt>` 后台子进程（type: "dream"）
4. 模型读 memory 目录，输出整合指令：合并近重复、纠错矛盾、相对日期改绝对、过时条目标 `disabled: true`、重建 MEMORY.md 索引
5. 失败/被杀 → 自动回滚锁 mtime

**内置护栏**：整合 prompt 里焊死纪律——不从日志臆测用户、不保存密钥/令牌、敏感内容必须标 `Privacy` 标签、一次最多新建 2 个文件。

> 状态：✅ 手动触发已实现；⏳ 自动定期触发（cron）留待。

---

## 具体例子：一段对话产生了什么

```
你："测试服在 10.0.0.7，conda 用 prod-ml，我们决定把 /clear 命令移除了"
```

| 时机 | 产生什么 | 写哪里 |
|------|----------|--------|
| 本轮结束 | session_memory checkpoint（goal + 消息摘要） | `~/.openharness/data/session-memory/<project>/<id>.md` |
| 会话结束 | personalization 抽出 `10.0.0.7`、`prod-ml` | `~/.openharness/local_rules/facts.json` + `rules.md` |
| 你敲 `/remember` | LLM 提取"移除 /clear 的决策" | `~/.openharness/data/memory/<project>/xxx.md` |
| 你敲 `/dream` | 整理 memory 目录，合并重复 | 原地修改 + 备份 |

**下次启动时**：
- `rules.md` 里的 `10.0.0.7` / `prod-ml` 自动注入 system prompt ✅
- memory 里的"移除 /clear"在相关对话时自动检索注入 ✅

---

## 两条"自动记忆"的区别

| | personalization | /remember（memory_extract） |
|--|-----------------|----------------------------|
| **触发** | 会话结束自动 | 手动 `/remember` |
| **方法** | 正则（10 个模式） | LLM 语义理解 |
| **抓什么** | 机械事实：IP、路径、环境名、端点 | 语义事实：决策、偏好、约束 |
| **成本** | 零（无 LLM 调用） | 有成本（一次 LLM 调用） |
| **存放位置** | `~/.openharness/local_rules/`（全局） | `memory/<项目>/`（项目级） |

---

## 容易混淆：两个"会话文件"

| | session_memory checkpoint | session 快照 |
|--|--------------------------|-------------|
| **目录** | `~/.openharness/data/session-memory/` | `~/.openharness/data/sessions/` |
| **内容** | goal + 消息摘要（12k 上限） | 完整消息历史 + 元数据 |
| **用途** | 给 compact 提供连续性 | 给 `/resume` 恢复会话 |
| **由谁读** | compact 边界（attachmentsProvider 注入） | `--continue` / `--resume` |

详见 [session-storage-design.md](./session-storage-design.md)。

---

## 功能状态汇总

| 功能 | 状态 | 备注 |
|------|------|------|
| tool_outputs inline/preview 截断 | ✅ | applyToolOutputBudget 在 query-engine.ts，写入 messages 前截断 |
| tool_outputs microCompact 接入 | ✅ | MCP 工具已纳入 microcompactable，同内置工具一起按 keepRecent 清理 |
| session_memory 每轮写入 | ✅ REPL + TUI | print 模式不写 |
| session_memory compact 读回 | ✅ | compact 时经 attachmentsProvider 注入摘要 prompt |
| personalization 抽取 | ✅ | 10 个正则，会话结束自动 |
| `/remember` 手动提取 | ✅ | LLM 提取，签名去重 |
| `/remember` 按轮自动 | ⏳ | 留待 |
| `/dream` 手动整合 | ✅ | 备份 + 锁 + 回滚 |
| `/dream` 自动定期触发 | ⏳ | 归 cron 留待 |
| memory 团队隔离 / 密钥扫描 | ⏳ | Phase C |

---

## 相关文档

- [services-memory-quartet-design.md](./services-memory-quartet-design.md) — tool_outputs / session_memory / memory_extract / autodream 详细设计
- [personalization-design.md](./personalization-design.md) — 环境事实抽取
- [session-storage-design.md](./session-storage-design.md) — 会话快照存储
