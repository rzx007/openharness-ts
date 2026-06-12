# 记忆系统总览

OpenHarness-ts 的"记忆"不是单一模块，而是**四层互补的体系**：从一轮对话内的
上下文预算，到跨会话的持久事实，再到定期的自我整理。本文是地图；各层细节见
对应设计文档。

## 四层一图

```
一轮之内     tool_outputs      工具输出预算/微压缩判定（防单轮上下文爆炸）
  │
一个会话     session_memory    每轮确定性 checkpoint（compact 连续性底座）
  │
跨会话       MemoryManager     持久记忆条目（frontmatter + 加权搜索 + MEMORY.md 索引）
  │            ├─ /remember    LLM 从本会话提取持久记忆（memory_extract）
  │            └─ personalization  环境事实正则抽取 → local_rules 注入 prompt
定期维护     autodream         /dream 梦境整合：合并/纠错/降噪/重建索引
```

## 各层职责与落盘位置

| 层 | 模块 | 落盘 | 触发 |
|----|------|------|------|
| 轮内预算 | `packages/services/src/tool-outputs.ts` | 无（纯判定） | compact/microcompact 链路（读回接线留待） |
| 会话 checkpoint | `packages/services/src/session-memory.ts` | `<dataDir>/session-memory/<项目>-<sha1>/<会话id>.md` | REPL 每轮自动写；compact 边界读回留待 |
| 持久记忆 | `packages/memory`（B.4） | `<dataDir>/memory/`（Markdown + frontmatter，`MEMORY.md` 索引） | 模型/用户写入；相关记忆按轮检索注入 prompt |
| 记忆提取 | `packages/services/src/memory-extract.ts` | 写进 MemoryManager | **`/remember`** 命令（自动按轮触发留待） |
| 环境事实 | `packages/personalization` | `~/.openharness/local_rules/{rules.md,facts.json}` | 三模式会话结束自动抽取；rules.md 注入 system prompt |
| 梦境整合 | `packages/services/src/autodream/` | 原地整理 memory 目录 + `<dataDir>/memory-backups/` | **`/dream [--preview]`**（自动触发归 cron 刀） |

## 数据流向（典型生命周期）

1. **会话中**：你提到"测试服在 10.0.0.7，conda 用 prod-ml"。
2. **每轮**：session_memory 写 checkpoint（goal/next_step/最近消息摘要）。
3. **会话结束**：personalization 正则抽出 IP/conda 环境 → `rules.md`；
   下次会话启动自动注入 system prompt。
4. **你敲 `/remember`**：LLM 审视本会话，把"测试服迁移决策"这类
   **不可从代码/git 推导**的事实写成持久记忆条目（签名去重 + 清单防概念重复）。
5. **隔段时间敲 `/dream`**：后台子进程整理 memory 目录——合并近重复、
   相对日期改绝对、矛盾事实纠错、过时条目标 `disabled: true`、重建 MEMORY.md。
   跑前整目录备份，失败回滚，`--preview` 只提方案。

## 两条"自动记忆"的分工

- **personalization**（正则，零成本）：抓**机械事实**——IP、路径、环境名、
  端点。不动 LLM，会话结束顺手做。
- **memory_extract**（LLM，有成本）：抓**语义事实**——决策、偏好、约束。
  提取 prompt 里焊死纪律：只存稳定且不可推导的事实、不存密钥。

## 安全护栏

- `/dream` 子进程虽带 `--dangerously-skip-permissions`，但跑前**整目录备份**
  （`restoreMemoryBackup` 可还原）、整合锁防并发、失败/被杀自动回滚时间戳。
- 整合 prompt 内置证据纪律：不从日志臆测用户、不保存任何密钥/令牌、
  敏感内容必须标 `Privacy`、一次最多新建 2 个文件。
- memory_extract 的 team scope 记录暂跳过（TS 无团队隔离，Phase C 缺口）。

## 相关文档

- [services-memory-quartet-design.md](./services-memory-quartet-design.md) —
  tool_outputs / session_memory / memory_extract / autodream 设计与差异表
- [personalization-design.md](./personalization-design.md) — 环境事实抽取
- PLAN-REMAINING.md B.4 — MemoryManager 模型（frontmatter/加权搜索/签名去重）

## 留待事项（汇总）

- compact 边界读回 session checkpoint（`sessionMemoryToCompactText` 已导出未消费）
- tool_outputs 阈值接进 compact/microcompact 链路
- `executeAutoDream` 自动触发 + memory_extract 按轮自动触发（归 cron/轮级管线）
- memory 团队隔离 + 密钥扫描（Phase C）
