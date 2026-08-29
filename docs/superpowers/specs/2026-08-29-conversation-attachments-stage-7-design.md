# 对话附件阶段 7：压缩连续性与本地资源生命周期设计

> 状态：已实现并通过全仓验收（2026-08-29）。本阶段完成本地附件在长对话、运行占用、物理回收和备份恢复中的闭环。Provider Files API、远端 `file_id` 缓存、PDF/Office 等二进制文档以及完整存储管理界面明确延期。

## 目标与边界

阶段 7 解决四件事：对话压缩后仍能继续使用附件；正在被会话、fork、replay 或活跃运行使用的附件不会被误删；逻辑删除后的 Blob 能在安全条件满足时物理回收；数据库与附件 Blob 能作为一个整体备份、检查和恢复。

本阶段继续只支持已经落地的图片和安全文本路线。图片由支持视觉的主模型直接读取，主模型不支持图片时由 `ImageToText` 调用本地 OCR。文本使用内联预览或 `attachment://` 资源读取。没有真正生成过的 OCR、摘要或索引不得被推断或伪造。

本阶段不实现：

- Provider Files API、远端文件 ID、credential scope 和远端过期重传；
- PDF、DOCX、XLSX、PPTX、压缩包及其他二进制文档；
- 文档转换、扫描 PDF OCR 和语义索引；
- 完整的 Desktop 配额配置和分类清理界面；
- 为暂时没有消费者的 Provider 文件接口预留半成品抽象。

Provider 文件缓存等真正出现原生远端文件输入后再设计，避免它与未来的文档转换方案互相限制。

## 一、附件感知的对话压缩

### 当前问题

现有 `CompactService` 能把最近文件路径、任务、计划和工具统计放进摘要 prompt，但不知道对话附件的稳定身份，也不知道已经生成了哪些 representation。持久化的 `session_input_attachment` 不会随 transcript 替换而丢失，但摘要后的 Agent 没有足够信息找到它们。

### 附件目录

压缩前由 session application 层查询当前会话的持久附件引用和 representation，生成有上限的结构化附件目录。每项至少包含：

- `assetId`；
- 来源 input ID 和会话内顺序；
- 显示名称、MIME、大小和附件意图；
- 当前可用状态；
- 资源 URI；
- 已完成 representation 的类型、处理器、处理器版本和有界预览；
- 推荐的继续访问方式，例如 `Read attachment://...` 或 `ImageToText`。

目录只记录仍被会话引用的资产。同一个 asset 在多个 input 中出现时保留来源关系，但在摘要 prompt 中可以合并重复的资源说明。

### 压缩规则

运行流程：

```text
持久附件引用
    ↓
查询资产与已完成 representation
    ↓
生成有界附件目录
    ↓
CompactService 把目录加入摘要 prompt
    ↓
摘要保留资源身份和继续访问方式
    ↓
原 input attachment refs 保持不变
```

- 不向摘要请求传入 Blob、Base64 或完整大文本。
- 已有 OCR 可以作为 OCR 预览出现，并明确标注来源、处理器和版本。
- 没有 OCR 的图片只说明可以调用 `ImageToText`，不得描述图片内容。
- 文本只放短预览；完整内容继续通过 `attachment://` 分段读取。
- 被删除、缺失或损坏的资产保留名称和错误状态，不能声称其仍然可读。
- 目录总项数、单项预览和总字符数都有硬上限；超限时保留最近使用项，并写明还有多少项未展开。
- compact 失败、被 hook 阻止或摘要模型不可用时，不改变持久附件引用。

Core 只扩展通用 `CompactAttachments` 输入结构，不直接依赖数据库或 Blob Store。session application 层负责构建目录并注入 runtime，使 CLI、Desktop 和未来客户端共享同一语义。

## 二、引用、lease 与安全等待期

### 持久引用

`session_input_attachment` 是物理回收的主要持久引用。fork 和 replay 必须创建自己的引用行，不能只复用 transcript 中的附件展示 part。只要任何引用仍指向一个 asset，该 asset 就不能物理清理。

消息 part 是投影和展示数据，不单独充当 Blob 所有权来源，避免 transcript 压缩、rewind 或重建投影改变资源所有权。

### 运行 lease

新增持久化 `attachment_lease`。lease 表示某个活跃操作正在读取附件，即使它的会话或 input 同时被删除，也必须暂缓回收。字段包括：

- lease ID；
- asset ID；
- owner kind，例如 `session_run`、`backup`；
- owner ID；
- `created_at`、`renewed_at`、`expires_at`。

同一 owner 对同一 asset 只有一条有效 lease。运行开始处理附件前批量取得 lease，运行中按固定间隔续期，正常结束主动释放。进程崩溃后 lease 不再续期，到期后由安全修复清理。

取得和续期 lease 必须验证 asset 仍存在。GC 判断时只认可 `expires_at > now` 的 lease。系统时间回拨不能把已认定过期并删除的 lease 重新变为有效。

### 安全等待期

资产逻辑删除后默认等待 7 天才允许物理回收。等待期使用 `deleted_at` 计算，并作为 retention policy 的附件字段暴露，测试可以注入更短时间。本阶段不增加用户设置项。

只有同时满足以下条件，资产才成为 GC 候选：

1. 状态为 `deleted`；
2. `deleted_at` 已超过等待期；
3. 没有 `session_input_attachment` 引用；
4. 没有有效 lease。

## 三、按内容哈希执行安全 GC

Blob Store 使用 SHA-256 内容寻址。多个 asset 可以共享同一 Blob，因此删除判断分成资产级和 Blob 级。

资产级条件满足后，GC 再查询同 SHA-256 的所有 asset。只要仍有 ready asset、持久引用、有效 lease，物理 Blob 就保留；当前 deleted asset 的元数据可以在不影响共享 Blob 的前提下单独清理。

GC 流程：

```text
取得单实例 GC 运行权
    ↓
清理过期 lease
    ↓
查询超过等待期的 deleted assets
    ↓
逐项复核引用和有效 lease
    ↓
按 SHA-256 复核共享使用者
    ↓
删除无人使用的 Blob
    ↓
清理 representation 和资产墓碑
    ↓
写入附件 GC 审计
```

安全要求：

- 判断条件和数据库清理在事务中完成，但文件系统删除不伪装成数据库事务。
- 文件删除成功或文件本来就不存在后，才能清理最终墓碑。
- 删除文件失败时保留墓碑并记录错误，下次重试。
- GC 重复运行结果一致；“文件已经不存在”按已完成处理。
- 同一 daemon 同时只允许一轮 GC，定时和手动入口共用一个 gate。
- GC 不处理 `staging`；上传临时文件继续由现有 recovery 负责。
- 审计记录扫描数、过期 lease、跳过原因、删除资产数、删除 Blob 数、释放字节和错误，不记录附件正文。

`AttachmentBlobStore` 增加受校验的列举、检查和删除能力。调用者只能传合法 SHA-256，路径始终由 Store 内部计算，不接受外部绝对路径。

## 四、一致性扫描和安全修复

新增只读 scanner，对数据库记录和物理存储做双向检查：

| 问题代码 | 含义 | 默认处理 |
| --- | --- | --- |
| `missing_blob` | ready 或被引用资产的 Blob 不存在 | 报告，禁止自动删除引用 |
| `size_mismatch` | Blob 实际大小与数据库不一致 | 报告为损坏 |
| `orphan_blob` | Blob 没有任何 asset 指向 | 超过等待期后可安全删除 |
| `stale_lease` | lease 已过期 | 可安全删除 lease |
| `dangling_representation` | representation 对应资产不存在 | 可安全清理 |
| `deleted_asset_retained` | deleted asset 已满足候选条件 | 交给 GC |
| `stale_staging` | 上传临时文件超期 | 交给现有 recovery |

scanner 返回稳定的问题代码、asset ID 或 SHA-256、严重程度和建议动作，不返回正文或主机私密路径。

提供三种应用层动作：

- `scan`：只检查，不修改任何数据；
- `repair-safe`：清理过期 lease、悬空 representation 和超过等待期的 orphan Blob；
- `gc`：按完整引用、lease、等待期和共享 SHA 规则回收 deleted asset。

缺失 Blob、大小不一致和仍被引用但不可读的资产只能报告。自动修复不得删除这些引用，也不得把损坏静默改成成功状态。

## 五、备份和恢复一致性

### Manifest v2

备份 manifest 升级为版本 2，包含：

- `database.sqlite`；
- `attachments` 目录是否存在；
- 原有 artifacts、memory、execution output 目录；
- 数据库内附件资产数；
- 唯一 Blob 数和总字节数；
- 创建备份时的一致性扫描摘要；
- 所有备份文件的 SHA-256 checksum；
- 原有进程恢复策略。

### 创建备份

备份在全局 operation barrier 内执行，阻止新的持久化写入并等待已有写操作结束。它不顺带执行破坏性 GC。

1. 清理已过期 lease。
2. 运行附件一致性扫描。
3. 若存在被引用资产的缺失 Blob 或大小错误，停止并列出问题。
4. 备份数据库。
5. 复制 attachments 和其他已配置目录。
6. 生成 manifest 与 checksums。
7. 对备份副本再次执行 checksum 和附件一致性检查。

### 恢复备份

1. 验证 manifest 版本和结构。
2. 验证 checksums，拒绝额外、缺失或被修改的文件。
3. 在备份源上打开数据库副本并检查 Blob 对应关系。
4. 预检所有目标，禁止覆盖非空目录。
5. 恢复到与正式目标同卷的临时目录。
6. 在临时目录再次校验。
7. 校验通过后切换为正式目标；失败时删除本次临时结果。

旧版 manifest 可以识别。若 v1 数据库不含附件记录，按原流程恢复；若数据库含附件引用但备份没有 attachments，则明确拒绝，提示该备份不完整。本阶段不兼容或迁移更早的实验性附件表结构。

## 六、诊断和基础存储统计

daemon 的 control/diagnostic 层提供统一附件存储摘要：

- importing、ready、failed、deleted 资产数；
- 唯一 Blob 数和物理字节数；
- 按 asset 逻辑大小估算的去重节省字节；
- 有效和过期 lease 数；
- missing、损坏和 orphan 数；
- 当前满足 GC 条件的资产数和预计可释放字节；
- 最近一次 GC 审计。

HTTP/control 路由暴露 `scan`、`repair-safe` 和 `gc`，继续使用 daemon 现有鉴权和 operation gate。Desktop 本阶段只接通最小调用与结果展示所需的 contract；完整图形化配额和分类清理页延期。

## 七、错误语义

新增稳定错误或问题代码：

- `attachment_blob_missing`；
- `attachment_blob_corrupt`；
- `attachment_lease_conflict`；
- `attachment_gc_busy`；
- `attachment_backup_incomplete`；
- `attachment_restore_inconsistent`。

面向用户的信息包含附件显示名和可执行建议；日志和诊断使用 asset ID、SHA-256、大小和错误码，不记录附件正文。任何一致性错误都不能降级成“忽略附件继续运行”。

## 八、主要代码区域

- `packages/core/src/engine/compact-service.ts`：结构化附件目录和 prompt 边界；
- `packages/services/src/session-runtime/`：lease、GC 审计、查询和迁移；
- `packages/services/src/attachment/`：Blob 检查、scanner、safe repair 和 GC；
- `packages/server/src/application/session/`：构建 compact 附件目录和运行 lease；
- `packages/server/src/application/backup/`：manifest v2 与一致恢复；
- `packages/server/src/application/retention/`：附件 retention/GC 入口；
- `packages/server/src/application/control/` 与 HTTP routes：诊断动作；
- Desktop shared contract：最小存储统计接口。

## 九、测试和验收门槛

### 压缩连续性

- 图片和文本附件在压缩后仍有稳定 asset ID、显示名和访问方式；
- 已有 OCR/text representation 的短预览可保留；
- 没有 OCR 时摘要 prompt 不含图片内容猜测；
- 大文本不会完整进入 compact prompt；
- compact 失败不改变 input attachment refs。

### 引用和运行安全

- fork 创建独立持久引用，原会话清理不影响 fork；
- replay 创建独立持久引用；
- 活跃 run lease 阻止 GC；
- run 正常结束释放 lease，崩溃 lease 到期后可清理；
- 安全等待期未结束时不物理删除；
- 多个 asset 共用一个 SHA 时不误删 Blob。

### GC 和扫描

- GC 连续运行两次保持正确；
- 并发 GC 只有一个实际执行者；
- 文件删除失败可重试且数据库不提前清理；
- scanner 的只读模式不改变数据库或文件；
- safe repair 不删除仍被引用的损坏记录；
- orphan Blob 只有超过等待期才删除；
- Windows 长路径和 Unicode 显示名不影响按哈希操作。

### 备份恢复

- 备份包含数据库引用的全部 Blob；
- 缺失 Blob、大小错误或 checksum 错误阻止备份/恢复；
- 备份和恢复都能处理去重 Blob；
- 恢复失败不留下半恢复数据库或附件目录；
- 不含附件记录的 v1 备份仍可恢复；
- 含附件记录但没有 Blob 的 v1 备份明确失败。

### 全仓验证

- Services、Core、Server、Desktop 相关测试通过；
- 全工作区测试、类型检查和文档检查通过；
- `git diff --check` 通过；
- 不回归图片原生输入、`ImageToText`、文本资源、fork 和 replay。

## 十、完成定义

只有同时满足以下条件，阶段 7 才算完成：

1. 对话压缩后 Agent 能基于稳定资源身份继续分析附件；
2. 引用、lease、等待期和共享 SHA 共同阻止误删；
3. GC 可重复、可审计、失败可重试；
4. scanner 能区分可安全修复和必须人工处理的问题；
5. 备份恢复把数据库和附件 Blob 作为一致整体；
6. 所有新增入口有稳定错误语义和测试；
7. Provider Files API 和二进制文档没有以半成品形式混入本阶段。

## 十一、实现与验收记录

阶段 7 已按本文边界完成，主要提交如下：

- `c8ab5f4`：附件目录进入对话压缩；
- `a15c5ca`：活跃运行 lease；
- `b7edaf5`：一致性扫描、安全修复与 GC；
- `966303b`：附件一致备份与恢复；
- `e405985`：存储诊断 HTTP 入口；
- `5dac4e3`：上传/GC 并发 gate、持久 GC 审计、同卷临时恢复与原子切换、Client/Desktop 最小调用链，以及旧注入 Agent 的能力探测兼容。

最终验证结果：

- 全工作区测试：58/58 个 Turbo 任务成功；
- 全工作区类型检查：57/57 个 Turbo 任务成功；
- Services 完整测试：24 个测试文件、222 个测试通过；
- Client 完整测试：3 个测试文件、64 个测试通过；
- Server HTTP 与系统路由定向回归：83 个测试通过；
- 文档检查：112 个 Markdown 文件通过；
- `git diff --check` 通过。

本阶段没有实现 Provider 远端文件缓存、PDF/Office/压缩包处理、分片上传、文件夹快照或完整存储管理页面。Desktop 只提供扫描、安全修复和 GC 的类型化 IPC 调用链，图形页面留到后续阶段。
