# 对话附件阶段 2：Prompt 引用与持久化历史设计

**状态：已确认，等待实现计划。**

## 目标

阶段 1 已经解决附件字节的上传、保存、安全读取和逻辑删除。阶段 2 负责把已经上传的附件变成对话输入的一部分，使一条 `SessionInput` 的文字、附件引用和 owning run（拥有这轮输入的运行记录）能够一起提交、一起恢复，并完整进入 SSE、Snapshot、Transcript、queue、retry、edit 和 fork。

本阶段不把附件交给模型，也不执行 OCR。模型原生图片输入属于阶段 4；不支持图片时由主 Agent 主动调用本地 `ImageToText` 的能力属于阶段 5。

## 固定决策

1. 使用独立的 `session_input_attachment` 表保存引用。它是“哪一轮输入引用了哪个附件”的唯一真实来源。
2. `SessionInputRecord.attachments` 是必填数组；无附件时为 `[]`，不保留旧协议的可选写法。
3. `attachment` message part 是由输入引用生成的 Transcript 投影，不是另一套所有权数据。
4. 未被引用的附件可以逻辑删除；已有引用的附件删除返回 `409 attachment_in_use`。
5. 已发送附件通过编辑或删除消息解除引用。阶段 2 不向普通历史消息提供“单独删除底层资产”的语义。
6. 删除引用不立即删除 Blob。物理回收由阶段 7 的 GC、lease 和安全等待期负责。
7. 带附件的 `steer` 在阶段 2 规范化为 queue；带附件的 queued input 不能 promote 到不支持结构化输入的 active run。
8. 数据库存储格式直接升级为 version 2。format 1 数据库明确拒绝启动，不做迁移、回填或读取兼容。
9. 同一附件可以被多条输入和多个 fork 复用；fork 复制引用记录，不复制 Blob。
10. `ImageToText` 的用户可见过程继续使用正常 tool use/tool result，不伪造成系统 transformation。

## 为什么选择独立引用表

附件引用不能只塞进 `session_input` 的 JSON，也不能只存在于 message part。

JSON 数组难以建立外键、唯一约束和引用索引，删除保护、配额和未来 GC 都需要扫描并解析所有输入。message part 则生成得晚于 admission；只用 part 会让 queued input 在投影完成前没有稳定附件所有权，也无法让 input、refs 和 run 原子提交。

因此数据流固定为：

```text
attachment_asset
       │
       ▼
session_input_attachment   ← 唯一真实引用来源
       │
       ├─ SessionInputRecord.attachments
       ├─ session.input.admitted
       ├─ Snapshot / Client state
       └─ attachment message parts
```

## 公共协议

### Prompt 附件输入

```ts
interface AdmitPromptAttachmentInput {
  assetId: string;
  intent?: AttachmentIntent;
  displayName?: string;
}

interface AdmitPromptInput {
  id?: string;
  sessionId: string;
  delivery?: InputDelivery;
  content: string;
  attachments?: AdmitPromptAttachmentInput[];
  metadata?: Record<string, unknown>;
}
```

输入规范化规则：

- 缺省 `attachments` 规范化为 `[]`。
- 缺省 `intent` 规范化为 `auto`。
- 缺省 `displayName` 使用 asset 当前的安全展示名。
- Client 提供的 `displayName` 使用与上传文件名相同的 Unicode 规范化、控制字符清理和长度限制。
- 附件顺序按数组顺序保存，`seq` 从 0 开始。
- 同一个 `assetId` 不能在一条 input 中出现两次。
- `content.trim()` 为空但附件非空时允许 admission。
- 文字和附件同时为空时返回 `400 prompt_content_required`。

### 持久引用

```ts
interface SessionInputAttachmentRecord {
  id: string;
  sessionId: string;
  inputId: string;
  assetId: string;
  seq: number;
  intent: AttachmentIntent;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
  createdAt: number;
}
```

`displayName`、`mediaType` 和 `sizeBytes` 保存发送时快照，使历史展示不受 asset 后续内部状态变化影响。`sha256` 不进入普通公开引用；daemon、OCR 和 Provider 路由需要时通过 `assetId` 查询资产。

### SessionInput

```ts
interface SessionInputRecord {
  id: string;
  sessionId: string;
  seq: number;
  delivery: InputDelivery;
  content: string;
  attachments: SessionInputAttachmentRecord[];
  promotedMessageId?: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}
```

协议解析必须拒绝缺少 `attachments` 的旧形状。引用的 `inputId` 和 `sessionId` 必须与所属 input 一致；`seq` 必须从 0 连续递增；同一 input 不能重复 `assetId`。

## 数据库结构

新增 `0014_session_input_attachments.sql`：

```sql
CREATE TABLE `session_input_attachment` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL,
  `input_id` text NOT NULL,
  `asset_id` text NOT NULL,
  `seq` integer NOT NULL,
  `intent` text NOT NULL,
  `display_name` text NOT NULL,
  `media_type` text NOT NULL,
  `size_bytes` integer NOT NULL,
  `metadata_json` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE cascade,
  FOREIGN KEY (`input_id`) REFERENCES `session_input`(`id`) ON DELETE cascade,
  FOREIGN KEY (`asset_id`) REFERENCES `attachment_asset`(`id`) ON DELETE restrict,
  UNIQUE (`input_id`, `seq`),
  UNIQUE (`input_id`, `asset_id`)
);

CREATE INDEX `session_input_attachment_input_seq_idx`
  ON `session_input_attachment` (`input_id`, `seq`);
CREATE INDEX `session_input_attachment_asset_idx`
  ON `session_input_attachment` (`asset_id`);
CREATE INDEX `session_input_attachment_session_idx`
  ON `session_input_attachment` (`session_id`);

ALTER TABLE `session_message_part` ADD `asset_id` text;
ALTER TABLE `session_message_part` ADD `attachment_intent` text;
ALTER TABLE `session_message_part` ADD `display_name` text;
ALTER TABLE `session_message_part` ADD `media_type` text;
ALTER TABLE `session_message_part` ADD `size_bytes` integer;
ALTER TABLE `session_message_part` ADD `transformation_kind` text;
ALTER TABLE `session_message_part` ADD `representation_id` text;
ALTER TABLE `session_message_part` ADD `processor` text;
ALTER TABLE `session_message_part` ADD `transformation_error` text;
```

`session_id` 是为按会话查询、配额和删除准备的冗余索引字段；写入时必须与所属 input 的 session 一致。

attachment/transformation part 的核心字段使用 `session_message_part` 上的类型化列持久化。它们不能塞进通用 metadata 或借用 tool 的 `input_json/output_json`；metadata 只保存 `inputAttachmentId` 等诊断信息。

### 一条 input 对应多个 run

当前 `session_run.input_id` 带有唯一约束，只允许一条 input 创建一个 run；这与 retry/replay 复用原 input 和附件引用的语义冲突。由于本阶段不兼容旧数据库，直接修改新数据库基线：

- `0000_session_runtime.sql` 中的 `input_id TEXT UNIQUE` 改为 `input_id TEXT`；
- `schema.ts` 中删除 `session_run_input_unique`，改为普通的 `session_run_input_idx`；
- `0014_session_input_attachments.sql` 只负责新增引用表，不承担旧表重建；format 1 会在运行任何新 migration 前被拒绝。

Store 提供两个含义明确的查询：

- `listRunsByInput(inputId)` 按 `createdAt + id` 返回该 input 的所有 run；
- `findOwningRunByInput(inputId)` 返回最早创建的 run，用于 admission 幂等和启动恢复。

retry/replay 创建的后续 run 在 metadata 中保存 `recovery.sourceRunId`。调用方不能再用含义含糊的 `findRunByInput` 猜测需要原 run 还是最新 run。

### 存储格式 version 2

阶段 2 修改存储格式基线，使全新数据库从 migration 链创建后直接写入 version 2。`SessionStore` 只接受 version 2：

```text
空数据库     → 创建最新结构，format = 2
format = 2   → 正常打开
其他 format  → migration 之前拒绝启动
```

format 1 的错误必须明确告诉用户移动或删除旧数据库后重启。系统不自动修改旧数据库，也不进入半升级状态。

## Admission 与事务

### 验证顺序

Prompt admission 在数据库事务内完成：

1. 读取 session 并确认可修改。
2. 规范化文字、delivery 和 ordered attachment inputs。
3. 对每个 asset 检查存在、`ready` 状态、大小和可信 MIME。
4. 检查重复 asset、`maxFilesPerPrompt` 和 `maxBytesPerPrompt`。
5. 按该 session 引用的唯一 asset 计算 `maxSessionReferencedBytes`；同一 asset 多次引用只计一次。
6. 创建 `session_input`。
7. 按顺序创建全部 `session_input_attachment`。
8. 需要 owning run 时创建 `session_run`。
9. 提交事务后才发布事件和进入执行队列。

任意一步失败都回滚 input、全部 refs 和 run，同时恢复 `SessionStore` 内存状态。不能发布指向已回滚数据的 SSE 事件。

### 资产状态

新引用只接受 `ready` asset：

```text
unknown / deleted → 404 attachment_not_found
importing / failed → 409 attachment_not_ready
ready              → 继续验证
```

当前 daemon 只有一个 bearer-token 鉴权域，阶段 2 不增加虚假的多用户 owner 字段。通过当前 daemon 上传的 asset 可以被该 daemon 内 session 引用。Client 只能传 `assetId`，不能传本地路径、staging 名或 storage key。

### 带附件的 steer

阶段 2 尚未建立阶段 4 的结构化运行时输入。带附件的 `delivery: "steer"` 规范化为 queue，返回的 `SessionInputRecord.delivery` 明确为 `queue`。无附件 steer 保持现有行为。

带附件的 queued input 在阶段 2 不能 promote 到 active run；它继续留在队列并返回 `409 attachment_structured_steer_unsupported`，不能只 promote 文字或丢弃引用。

## 幂等语义

相同 `input.id` 的重复请求只有在规范化后的全部内容相同时才返回第一次的 input/run：

- session；
- content；
- 最终 delivery；
- 去掉传输 trace 后的 metadata；
- ordered refs 中每项的 `assetId + intent + displayName`。

引用记录自己的随机 ID 和时间戳不参与比较。附件数量、顺序、asset、intent 或 displayName 任一变化都返回 `409 prompt_id_conflict`。并发的相同 admission 最终只能产生一条 input、一组 refs 和一个 owning run。

## 事件、Snapshot 与 Client

原子 admission 继续只发布一条 `session.input.admitted`，payload 中的 input 携带完整 `attachments`。阶段 2 不为每个引用发布单独 linked 事件，避免 Client 观察到“input 已出现、附件尚未到齐”的中间状态。

Snapshot 和 SSE 使用完全相同的 `SessionInputRecord`。Client reducer 继续按 input ID upsert；snapshot 与 SSE 任意到达顺序、事件重放或断线恢复都不能产生重复引用。

Session 加载时一次性读取全部 refs，按 input ID 分组并按 seq 排序，再组装 input。禁止对每条 input 单独执行附件查询。

## Transcript 投影

### part 类型

```ts
type SessionMessagePartType =
  | "text"
  | "attachment"
  | "transformation"
  | "reasoning"
  | "tool"
  | "tool_result"
  | "error"
  | "log";
```

附件 part 使用类型化字段：

```ts
interface SessionAttachmentMessagePartRecord extends SessionMessagePartRecord {
  type: "attachment";
  assetId: string;
  intent: AttachmentIntent;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
}
```

part metadata 保存 `inputAttachmentId` 以便诊断和修复，但核心字段不能只藏在 metadata。

转换槽位定义为：

```ts
interface SessionTransformationMessagePartRecord extends SessionMessagePartRecord {
  type: "transformation";
  assetId: string;
  kind: "direct" | "document_extract" | "tool_mount";
  status: "pending" | "running" | "completed" | "failed";
  representationId?: string;
  processor?: string;
  error?: string;
}
```

阶段 2 只定义和解析 transformation part，不主动创建它。只有后续真实发生原生路由、文档提取或受控挂载时才写。`ImageToText` 继续投影为正常工具调用。

### 用户消息投影

input 文字非空时生成 text part；每个 ref 按 seq 生成 attachment part。纯附件 input 不生成空 text part。

input ref 是唯一真实来源：ref 存在但 part 缺失时，投影修复可以重建 part；part 存在但 ref 不存在时属于一致性错误，不能把孤立 part 当成新引用。

Agent transcript 必须恢复结构化的文字与附件元数据，不能继续只抽取文本。具体返回一个 sidecar（与消息并列的附件索引）结构：`{ messages, attachmentsByMessageId }`。阶段 2 仍只把 `messages` 交给 `agent.loadHistory()`；sidecar 保存 `assetId`、intent、显示名、类型和大小，留给阶段 4 的模型路由读取，不能伪装成 `ImageBlock` 或未知 Provider content part。

文本导出明确列出附件；JSON 导出保留完整结构。阶段 3 再把 attachment part 渲染为缩略图和文件卡片。

## 生命周期

### Queue 与重启

附件在 admission 前已经进入 daemon Blob Store。排队期间不依赖 Client 原文件；Client 退出、原文件删除或 daemon 重启都不影响 queued run。

run 开始前重新确认 asset、ref 和 Blob 一致性，但不能把已经成功 admission 的历史引用当成新引用重新计费或静默移除。

### Retry 与 Replay

失败 run 的 retry 默认复用原 input 和 refs，只创建新 run。网络 admission 重试使用相同 input ID，并遵守完整 ordered refs 幂等比较。

普通 replay 默认也是原 input 新 run。现有 interrupted-run resume 接口中的 `id` 在阶段 2 明确表示 recovery run ID；相同 `id + sourceRunId` 返回第一次结果，变化的 source 返回 `409 prompt_id_conflict`。如果未来提供“复制为新消息”，必须创建新 input 和新 refs，仍然复用 asset，不能重新读取用户原路径。

### Edit

编辑最新消息创建新 input 和新 refs，不原地修改旧引用。截断旧 Transcript、删除被替换 input/refs、创建新 input/refs/run 必须处于同一事务。失败时旧历史完整保留。

解除引用后的 asset 不立即删除，只变成未来 GC 可回收候选。

### Fork

fork 创建新的 session、input、ref、message 和 part ID，复用原 assetId 和 Blob。子 session 不得直接指向父 session 的 input。删除任一分支只删除该分支的引用，不能影响其他分支读取附件。

### Compaction

阶段 7 才完成附件感知 Compaction，但阶段 2 必须保证当前压缩不会删除 input refs。压缩历史只保留轻量的 assetId、显示名、类型和顺序，不嵌入完整 Blob 或 base64，也不伪造没有产生过的 OCR 摘要。

### Session 删除

归档 session 不删除 input、refs 或 asset。硬删除 session 时级联删除其 input、refs、messages、parts、runs 和 events，但不删除 attachment asset 或 Blob。

## 附件删除保护

应用服务提供按 asset 查询和计数 refs 的能力。删除 asset 时，在同一个数据库事务中检查引用数并执行逻辑删除：

```text
referenceCount = 0 → 允许逻辑删除
referenceCount > 0 → 409 attachment_in_use
```

响应可以返回引用数量，但默认不返回全部 session/input ID。数据库外键是最后保护，应用层必须映射成稳定错误，不能泄漏 SQLite 文本。

阶段 2 永远不物理删除 Blob。

## 错误契约

| 错误码 | HTTP | 条件 |
|---|---:|---|
| `prompt_content_required` | 400 | 文字和附件同时为空 |
| `attachment_duplicate_reference` | 400 | 同一 input 重复 asset |
| `attachment_not_found` | 404 | asset 不存在或已删除 |
| `attachment_not_ready` | 409 | importing、failed 或内部不可引用状态 |
| `prompt_id_conflict` | 409 | 相同 input ID 的规范化内容不同 |
| `attachment_in_use` | 409 | 删除仍有引用的 asset |
| `attachment_structured_steer_unsupported` | 409 | promote 带附件的 queued input |
| `attachment_count_exceeded` | 413 | 超过单 Prompt 文件数 |
| `attachment_prompt_size_exceeded` | 413 | 超过单 Prompt 总字节数 |
| `attachment_session_size_exceeded` | 413 | 超过 Session 唯一资产总字节数 |

HTTP 层只校验 JSON 基本形状和明显异常的数组长度。资产状态、配额、引用和幂等由应用服务与 Store 事务负责。

## Client SDK

所有会创建 Prompt 的 Client 路径复用同一个附件输入类型，包括普通 admit、新会话首条输入、queue、edit，以及需要创建新 input 的 replay。Client 可以为 UI 提前查询 asset，但 daemon 始终执行最终校验。

Client 直接复用 protocol 的 `SessionInputAttachmentRecord`、attachment part 和 transformation part 类型，不维护一套名字不同的镜像接口。

## 测试与验收

### Protocol

- `SessionInputRecord.attachments` 必填，缺少字段失败。
- 空数组、纯附件 input、ref 字段和枚举解析。
- ref 的 session/input 一致、连续 seq 和 asset 唯一性。
- attachment/transformation part 解析。
- Snapshot 和 SSE 序列化保留完整附件。

### Store 与数据库

- 空数据库创建 format 2 完整结构。
- format 1 在 migration 前明确拒绝。
- 新表外键、唯一约束和索引。
- input、refs、run 原子提交与失败回滚。
- 删除 input 级联删除 refs；有引用 asset 不能删除。
- 不同 input/fork 可以引用同一 asset。
- 重启后引用顺序、intent 和快照字段不变。
- 批量加载引用，不产生逐 input 查询。

### Application

- 纯文本、纯附件和完全空 Prompt。
- unknown/importing/failed/deleted asset。
- 数量、Prompt 总大小和 Session 唯一资产总大小。
- 重复 asset。
- 完全相同幂等重试，以及文字、顺序、intent、displayName 变化冲突。
- 带附件 steer 进入 queue；带附件 queued input 不能 promote。
- retry 复用 refs；edit 原子替换 refs；fork 创建新 refs 并复用 asset。

### HTTP、Client 与恢复

- 真实上传后发送纯附件 Prompt，读取 Snapshot、重放 SSE、重启 daemon 后数据一致。
- Prompt 失败不留下 input、ref 或 run。
- 有引用 DELETE 返回 409；解除引用后允许逻辑删除。
- 鉴权和错误响应不泄漏 Blob 路径。
- Client 请求 JSON、响应解析和 reducer 去重。
- 事务提交后、事件发布前崩溃时，重启能恢复完整 input/ref/run。
- 1000 条 input 多引用加载。
- 多个 fork 逐个删除不影响剩余引用。
- 并发相同幂等请求只产生一组 refs 和一个 owning run。

## 不进入阶段 2

- Desktop 文件选择、拖放、粘贴、上传进度和附件卡片；
- 缩略图生成和展示；
- 模型附件能力判断与 Provider 原生图片转换；
- OCR、`ImageToText` 改造和 `@arcships/light-ocr`；
- PDF、Office、代码、压缩包提取；
- Agent 文件挂载；
- 分片上传和文件夹入口；
- Blob GC、Provider 文件缓存和实际 transformation 执行。

## 完成标准

阶段 2 只有在以下条件全部满足后才完成：

1. 附件随 Prompt 原子 admission，纯附件 Prompt 可用。
2. input、ordered refs 和 run 不出现部分提交。
3. ordered refs 的 asset、顺序、intent 和 displayName 参与幂等判断。
4. queue、retry、edit、fork 和 restart 不丢引用。
5. Snapshot、SSE、Client、Transcript 和 Agent transcript 使用同一引用事实。
6. 已引用附件不能直接删除，删除一个 fork 不影响其他 fork。
7. format 1 数据库明确拒绝，不存在兼容分支或半升级状态。
8. 完整测试、类型检查、migration 检查、文档检查和独立代码审查通过。
