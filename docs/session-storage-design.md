# 设计：Session 存储增强（E.6 第二刀）

> 状态：已批准。移植 Python `services/session_storage.py`（230 行），
> 替换 TS 现状的「平铺 `<sessionsDir>/<id>.json`」。

## 现状缺口

TS（apps/cli main.ts 自带逻辑 + services/session 旧 SessionStorage 类）：
- 会话平铺在全局 sessions 目录，**多项目混在一起**；
- 无 `latest.json`（`--continue` 靠文件名排序猜最新）；
- 不持久化 tool_metadata；无 Markdown 导出；无 summary 字段。

## 移植面（packages/services/src/session/storage.ts）

- `getProjectSessionDir(cwd)`：`<sessionsDir>/<项目名>-<sha1(cwd)前12>/`
  （哈希式与 session-memory 完全一致）。
- `saveSessionSnapshot({cwd, model, systemPrompt, messages, usage, sessionId?, toolMetadata?})`：
  - `latest.json` + `session-<id>.json` **双写**（原子写）；
  - tool_metadata 按白名单 `_PERSISTED_TOOL_METADATA_KEYS` 过滤 + 深度 sanitize；
  - summary 取首条非空 user 消息前 80 字符；记 message_count/created_at。
- `loadSessionSnapshot(cwd)`：读 latest.json。
- `listSessionSnapshots(cwd, limit=20)`：session-*.json 新→旧 + latest 去重补位，
  按 created_at 排序。
- `loadSessionById(cwd, id)`：named 优先，latest 兜底（id 匹配或 "latest"）。
- `exportSessionMarkdown({cwd, messages})`：transcript.md（角色分节 +
  ```tool / ```tool-result 围栏）。

## 适配决策

- 消息形状：宽松 `{role?/type?, content}`（与 session-memory 同思路），
  不引 pydantic 式校验。配对修复做在 **load 侧**（Python save/load 双侧）：
  读回时剔除尾部悬挂 tool_use 与孤儿 tool_result——崩溃/MaxTurns 中断落盘的
  断链历史 resume 后会被 API 直接 400，必须修复。
- ✅ toolMetadata 已投喂：`saveSessionSnapshot()` 调用处传入
  `engine.getToolMetadata?.()` ，`persistableToolMetadata()` 按白名单过滤后落盘。
- ✅ Ctrl+C 保存：REPL `rl.on("close")` 改为 async IIFE，退出前 `await saveSessionSnapshot`。
- ✅ `/export` 命令：`/export [filename] [--json]`，`.json` 后缀或 `--json` 标志
  输出 JSON（session_id/model/exported_at/messages），否则 Markdown；默认写
  `~/.openharness/data/exports/`。`exportSessionMarkdown` 仍用于 session 目录
  transcript 落盘，`/export` 走独立渲染路径（不依赖 cwd/storage）。
- 留待：systemPrompt 传空串、usage 为 TS camelCase（与 Python 快照不互换）；
  compact 侧读回 checkpoint。
- 旧 `SessionStorage` 类与 main.ts 平铺逻辑：CLI 接线改走新函数；
  **向后兼容**——resume 找不到项目分目录时回退读旧平铺文件。
- `/dream` 的 `listSessionsTouchedSince` 当前扫 `getSessionsDir()` 平铺根，
  接线后改传项目分目录。

## 测试

- 路径哈希稳定；双写一致；tool_metadata 白名单（额外键被丢弃、Path→字符串
  等 sanitize）；summary 提取；list 排序/去重/limit；loadById 三分支；
  markdown 导出结构。OPENHARNESS_CONFIG_DIR 临时目录隔离。
