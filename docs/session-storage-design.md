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
  不引 pydantic 式校验；`sanitize_conversation_messages` 的配对修复在 TS
  compact 链路已有，存储层不重复做（差异表记录）。
- 旧 `SessionStorage` 类与 main.ts 平铺逻辑：CLI 接线改走新函数；
  **向后兼容**——resume 找不到项目分目录时回退读旧平铺文件。
- `/dream` 的 `listSessionsTouchedSince` 当前扫 `getSessionsDir()` 平铺根，
  接线后改传项目分目录。

## 测试

- 路径哈希稳定；双写一致；tool_metadata 白名单（额外键被丢弃、Path→字符串
  等 sanitize）；summary 提取；list 排序/去重/limit；loadById 三分支；
  markdown 导出结构。OPENHARNESS_CONFIG_DIR 临时目录隔离。
