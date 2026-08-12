# 设计：Personalization 环境事实抽取（C.5）

> 状态：事实抽取、持久化与 prompt 注入已实现；session-end 自动抽取目前没有应用入口接线。记忆体系全景见 [memory-system.md](./memory-system.md)。
> 新建 `packages/personalization`，移植 Python
> `personalization/{extractor,rules,session_hook}.py`（共 273 行）。
>
> TUI / daemon session 的 session-end 抽取尚未接线；prompt 注入仍对所有经 `packages/prompts` 构建的 runtime 生效（含 daemon），只要 `rules.md` 非空。

## 它做什么

会话结束时用 10 个正则从对话文本里抽「环境事实」（SSH 主机、服务器 IP、数据
路径、conda 环境、Python 版本、API 端点、环境变量、git 远端、Ray 集群、cron
表达式），去重合并持久化到 `~/.openharness-ts/local_rules/`：

```
local_rules/
├── facts.json   # {facts: [{key,type,label,value,confidence}], last_updated}
└── rules.md     # 由 facts 重新生成的分组 Markdown（自动生成，勿手改）
```

下次会话启动时 `rules.md` 注入 system prompt（CLAUDE.md 段之后），模型自动
带着「这台机器的事实」工作。

## 模块（对齐 Python）

- `extractor.ts`：`FACT_PATTERNS`（10 个）、`extractFactsFromText`（去重、
  IP 假阳性过滤 0./255./127.0.0.1、值长度≥3、剥尾部标点）、
  `factsToRulesMarkdown`（按类型分组的固定标题表）。
- `rules.ts`：`loadLocalRules`/`saveLocalRules`/`loadFacts`/`saveFacts`
  （写入带 last_updated ISO 时间戳）/`mergeFacts`（按 key 去重，置信度高者胜）。
- `session-hook.ts`：`updateRulesFromSession(messages)`——抽取 → 合并 →
  双写 facts.json + rules.md，返回新增数。消息形状取 TS 的
  `{role, content: string | {text?}[]}` 宽松结构。

## 接线（R2）

- **prompt 注入**：`packages/prompts` 的 system prompt 构建在 CLAUDE.md 段后
  追加 `# Local Environment Rules\n\n<rules.md 内容>`（非空才注入）。
- **session-end 触发**：`updateRulesFromSession(messages)` 已作为可调用能力提供，但当前 standalone CLI、TUI/daemon archive、interrupt 与进程退出路径均未自动调用。
- **边界**：framework 的 `OpenHarnessAgent.close()` 只管理 live 执行资源，不擅自写 personalization durable state；应由 standalone host 或 daemon session lifecycle 在拥有完整 transcript 的位置调用。旧 BackendHost shutdown 路径已删除，不要再按该路径实现。

## 与 Python 差异

| 点 | Python | TS | 原因 |
|----|--------|----|------|
| 触发点 | ui/runtime 关停一处 | 尚未接入应用入口 | standalone host 与 daemon 需分别选择拥有完整 transcript 的 lifecycle hook |
| 日志 | logging.info | 无（静默） | TS 无 logger 基建 |
| 消息形状 | ConversationMessage.content blocks | 宽松 `{role?, content: string \| unknown[]}` | 适配 TS 引擎消息（SystemMessage 无 role） |
| git_remote 正则 | 懒惰 `\S+?` 后仅跟可选组 → 恒捕获 1 字符,被长度过滤丢弃(死代码) | 追加 `(?=\s\|$)` 锚,真正捕获 `owner/repo` | 修 Python 的失效模式 |
| prompt 注入包装 | 外层再包一层 `# Local Environment Rules` 标题(与 rules.md 自带标题重复) | 直接注入 rules.md 原文 | 避免双标题 |
| 信号路径 | 单一关停钩子,同样不覆盖信号杀进程 | SIGINT/SIGTERM 硬杀进程时可能丢当轮事实(swarm 信号钩子保持最小,不挂载) | 对齐 Python 留待 |
| 配置目录 | 默认 ~/.openharness-ts | 尊重 OPENHARNESS_CONFIG_DIR(仓库既有约定) | 测试隔离/Electron 预留 |

## 测试

- extractor：10 类正则各至少 1 例、IP 假阳性过滤、去重、尾部标点剥除、
  markdown 分组输出。
- rules：load/save 往返、mergeFacts 置信度胜出与新 key 追加、目录懒建。
- session-hook：端到端（消息 → facts.json + rules.md 落盘 → 返回新增数）、
  空会话返回 0。
- prompts 注入：rules.md 存在时进 prompt、为空不注入。

每轮 `pnpm check-types` + `pnpm test` 全绿。
