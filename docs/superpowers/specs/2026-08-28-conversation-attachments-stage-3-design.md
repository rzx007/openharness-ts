# 对话附件阶段 3：Desktop 上传、草稿与消息展示设计

**状态：设计已确认，待实施。**

## 背景

阶段 1 已经提供 daemon 所有的附件资产、内容寻址 Blob、单文件流式上传、安全下载和逻辑删除。阶段 2 已经把有序附件引用接入 Prompt admission、持久化、Snapshot、SSE、Transcript、queue、retry、edit、fork 和 restart。

阶段 3 要补齐用户在 Desktop 里实际使用附件的闭环：选择、拖入或粘贴文件后立即上传；在 Composer 中查看进度、取消、重试和移除；随文字或单独发送；最后在消息历史中稳定展示、打开和下载。

本阶段仍不把附件交给模型。阶段 4 才接模型原生图片输入；阶段 5 才把 `ImageToText` 改为主模型不支持图片时由主 Agent 调用的本地 OCR 工具。

## 目标

1. 文件选择、拖放和剪贴板图片进入同一套附件上传流程。
2. Electron renderer 不接触本地完整路径，不把大文件整体读入 renderer 内存。
3. 新会话与已有会话都能维护彼此隔离的文字和附件草稿。
4. Composer 能展示上传中、已完成、失败和取消状态，并支持取消、重试与移除。
5. 所有附件 ready 后，允许“文字 + 附件”或“仅附件”发送。
6. optimistic message、IPC 返回、Snapshot 和 SSE 任意先后到达时，不重复或丢失附件卡片。
7. 历史消息能展示图片缩略图或普通文件卡片，并通过 daemon 副本打开或下载。
8. 主动内容不能在特权 renderer 中执行；文件路径、鉴权信息和原始错误不能泄漏到页面。
9. 开发模式和自动化测试完成全链路；生产构建默认不开放附件发送。

## 非目标

- 不实现 Provider 原生图片输入、模型 capability 路由或 `ContentBlock[]` 转换；这些属于阶段 4。
- 不调用 OCR，不修改 `ImageToText`，不生成 OCR representation；这些属于阶段 5。
- 不提取 PDF、Word、文本或代码内容；这些属于阶段 6。
- 不实现 resumable/chunked upload、后台 GC 或跨重启草稿恢复。
- 不实现文件夹遍历或文件夹上传；“添加文件夹”入口只保留视觉位置，阶段 8 才开放。
- 不支持编辑已发送消息的附件集合。

## 已确认的产品决策

1. 采用横向附件卡片，位置在 Composer 内、文字编辑区上方，与用户提供的参考界面一致。
2. 图片显示缩略图；普通文件显示类型图标。卡片承担文件名、类型/大小、上传进度、错误和操作。
3. 用户选择、拖入或粘贴后立即上传，不等点击发送。
4. 发送要求全部草稿附件 ready；任一附件仍在上传或失败时，发送按钮不可用。
5. 文字为空但至少有一个 ready 附件时允许发送；文字和附件都为空时禁止发送。
6. “添加文件夹”图标和菜单项保留，但禁用并提示“后续版本开放”。
7. renderer 保存草稿展示状态；Electron Main 保存真实路径、上传任务和取消能力。
8. 草稿按 `new-conversation` 或 `sessionId` 隔离；切换会话保留，应用重启不恢复。
9. 最近一条带附件的用户消息仍可编辑文字，但原附件只读，不允许新增、删除或重新排序，也不重复上传。
10. 开发模式和测试完整开放；生产构建默认关闭附件发送，阶段 5 验收后再默认开启。

## 用户界面

### Composer 布局

附件区只在草稿含附件或编辑的消息含只读附件时出现。它位于 `RichPromptInput` 上方，使用现有 `AttachmentGroup` 和 `Attachment` UI 原语扩展实现：

- 单行横向排列，溢出时横向滚动；
- 卡片宽度稳定，不随长文件名无限扩张；
- 文件名单行省略，悬停或聚焦后可查看完整安全展示名；
- 图片卡片左侧是缩略图，其他文件使用格式图标；
- 右上角提供与状态相符的移除或取消操作；
- 上传中在卡片底部显示进度条和百分比；
- 失败状态显示短错误文案，并提供重试、移除；
- 图片预览失败时退化为普通图片文件卡片，不改变上传或发送状态。

附件多时只滚动附件行，不继续抬高输入框。窄窗口下保持可操作的最小卡片宽度，触控板、滚轮横向手势、键盘左右方向键均可移动焦点。

### 添加入口

`PlusMenu` 提供：

- **添加文件**：打开允许多选的系统文件选择框；
- **添加图片**：打开仅显示常用安全位图格式的系统文件选择框；
- **添加文件夹**：保留图标和位置，设置 disabled，并显示“后续版本开放”。

系统选择框的扩展名过滤只用于方便选择，不构成安全校验。daemon 仍按实际请求字节、声明媒体类型、文件大小和资产规则做最终判断。

### 拖放和粘贴

文件拖入 Composer 时显示清晰的 drop target。释放后把所有普通文件交给 Main；目录和非文件项目被拒绝，并给出可理解的提示。

剪贴板按以下优先级处理：

1. 有文件项时添加文件项；
2. 没有文件项但有图片字节时，把图片字节交给 Main 作为无本地路径的上传源；
3. 否则保留 Lexical 现有的纯文本粘贴行为。

一次操作中的每个条目都生成独立草稿。相同内容可以被添加多次，本阶段不在 UI 层擅自去重；daemon 的 Blob 去重仍然生效。

## 进程边界与职责

### Renderer

Renderer 负责：

- 按 scope 保存文字和附件草稿；
- 展示文件安全元数据、进度、错误和消息附件；
- 发起选择、上传、取消、重试、移除、预览、打开和下载命令；
- 生成发送快照和 optimistic message；
- 依据 `draftId + taskId` 丢弃迟到事件；
- 创建和释放缩略图 Blob URL。

Renderer 不保存真实路径，不直接打开 `file://`，不接收 Node `ReadStream`，也不把本地文件整体转换成 Data URL。

### Electron Main

Main 负责：

- 调用原生 `dialog.showOpenDialog`；
- 从 drop/clipboard 安全提取 Electron 可访问的文件句柄或字节；
- 校验所选条目是普通文件而不是目录、设备或符号链接目标；
- 持有真实路径和上传任务；
- 创建读取流，统计已读字节并调用 Client `uploadAttachment`；
- 通过节流的 IPC 事件报告进度；
- 使用 `AbortController` 取消读取和 HTTP 请求；
- 把 daemon/client 错误映射成稳定、可展示的 Desktop 错误；
- 窗口销毁时取消该窗口仍在运行的上传任务。

Main 的任务表按 `webContents.id + taskId` 隔离。一个 renderer 不能取消或订阅另一个窗口的上传任务。

### Daemon

Daemon 继续作为资产和消息引用的唯一真实来源：

- `POST /attachments` 保存字节并返回 `AttachmentAssetRecord`；
- 附件元数据、内容下载和逻辑删除继续使用阶段 1 接口；
- Prompt admission 使用阶段 2 的 ordered attachment refs；
- Snapshot/SSE/Transcript 使用阶段 2 的 typed attachment parts。

Desktop 不建立另一份附件数据库，也不把上传成功等同于“已经被消息引用”。

## Desktop 公共类型

共享类型放在 `apps/desktop/src/shared/`，由 Main、preload 和 renderer 共用。命名可在实现计划中按现有文件组织调整，但语义固定如下：

```ts
type DesktopAttachmentDraftStatus =
  | "uploading"
  | "ready"
  | "failed"
  | "cancelled";

interface DesktopAttachmentDraft {
  draftId: string;
  taskId: string;
  displayName: string;
  declaredMediaType: string;
  sizeBytes: number;
  status: DesktopAttachmentDraftStatus;
  bytesUploaded: number;
  progress: number | null;
  assetId?: string;
  mediaType?: string;
  error?: DesktopAttachmentError;
}

interface DesktopPromptAttachmentInput {
  assetId: string;
  intent: "auto";
  displayName: string;
}

interface SendDesktopPromptInput {
  id: string;
  sessionId: string;
  content: string;
  attachments: DesktopPromptAttachmentInput[];
}
```

`attachments` 在 Desktop 边界使用必填数组，无附件时为 `[]`。这样 renderer、preload、Main 和测试不会继续传播“字段可能不存在”的旧形状。

Desktop transcript 类型补齐阶段 2 已存在的 `attachment` 和 `transformation` message part。阶段 3 只渲染 transformation 的占位状态；不会自己生成 transformation。

### IPC 命令和事件

preload 暴露窄接口，不暴露通用文件系统能力：

```ts
attachments.pickFiles(options)
attachments.pickImages()
attachments.uploadPicked({ draftId, sourceToken })
attachments.uploadClipboardImage({ draftId, bytes, displayName, mediaType })
attachments.cancelUpload({ taskId })
attachments.deleteUnreferenced({ assetId })
attachments.readPreview({ assetId })
attachments.saveAs({ assetId })
attachments.open({ assetId })
attachments.onUploadProgress(listener)
```

`sourceToken` 是 Main 创建的短生命周期、不透明句柄。Renderer 收不到路径；句柄只能由创建它的窗口消费，成功开始上传、取消、超时或窗口关闭后失效。

IPC 事件至少包含 `draftId`、`taskId`、已读取字节和总字节。完成事件包含安全的 asset 元数据，失败事件只包含稳定错误码、用户文案和是否可重试。

## 草稿状态模型

### Scope

Renderer 中的草稿容器按以下 key 隔离：

```text
new-conversation
session:<sessionId>
```

每个 scope 保存自己的文字草稿、附件顺序和附件状态。切换会话只切换当前 scope，不移动对象。新会话创建成功后，把 `new-conversation` scope 原子迁移到新 `sessionId`；发送成功后只清空本次发送快照对应的内容。

草稿只存在于 renderer 内存，不写数据库或磁盘。应用退出后不恢复。Main 不保存 Composer 草稿，只持有当前运行中的上传任务和 source token。

### 单附件状态机

```text
选择/拖入/粘贴
       │
       ▼
  uploading ──────取消──────> cancelled ──移除──> 删除卡片
       │
       ├────失败────────────> failed ─────重试──> uploading
       │                                      │
       └────上传完成────────> ready ────移除──> 删除卡片
```

每次重试生成新的 `taskId`，但保留 `draftId` 和卡片位置。任何事件只有同时匹配当前 `draftId` 和当前 `taskId` 才能修改状态。旧任务迟到的 progress、success 或 failure 全部忽略。

`progress` 在总大小可信且大于零时为 `0..1`；无法确定总大小时为 `null`，界面显示不定进度。进度事件要节流，避免大文件上传导致 renderer 高频重绘；完成和失败事件不能被节流丢失。

### 移除和未引用资产

- uploading：先取消任务，再删除卡片；
- failed/cancelled：直接删除卡片；
- ready 且尚未进入发送快照：删除卡片后请求逻辑删除该 asset；
- daemon 返回 `attachment_in_use`：说明资产已经被消息引用，视为无需清理草稿，不能删除历史资产；
- 网络或 daemon 不可用导致清理失败：不阻塞 UI，记录诊断信息，物理 Blob 由阶段 7 GC 收束。

删除逻辑资产不等于立即删除 Blob。阶段 3 不实现物理回收。

## 上传流程

### 系统选择框

```text
PlusMenu
  → renderer 调 attachments.pickFiles/pickImages
  → Main 打开系统 dialog
  → Main 为每个普通文件创建 sourceToken，返回安全元数据
  → renderer 按选择顺序创建卡片
  → renderer 为每张卡片调用 uploadPicked
  → Main fs.createReadStream → Client.uploadAttachment → daemon
  → Main 发送 progress
  → daemon 返回 ready asset
  → Main 发送 success，renderer 把卡片改为 ready
```

多个文件可以并发上传，但 Main 使用固定并发上限，避免一次选择大量文件耗尽文件句柄和网络。实现计划应根据现有 Desktop 调度方式选择默认值并用测试固定；这不是全局 daemon 配额。

### 拖放

drop 入口与 picker 共享 source token 和上传服务。renderer 只负责把 Electron 暴露的 file 对象交给受限 bridge；Main 解析后才决定是否接受。目录在阶段 3 明确拒绝，不能偷偷递归遍历。

### 剪贴板图片

剪贴板图片可能没有稳定路径。preload 只允许 renderer 传递本次 paste 事件得到的图片字节、媒体类型和建议文件名；Main 设置长度上限后以字节流上传。它与路径型上传共用任务表、进度事件和完成结果。

纯文本 paste 继续由 Lexical 处理。含文件或图片的 paste 必须阻止同一个二进制条目被重复处理，但不能吞掉与附件无关的文本，具体混合剪贴板策略用组件测试固定。

## 发送与 optimistic transcript

### 发送门槛

`canSubmit` 改为同时判断文字、附件和附件状态：

```text
有非空文字或至少一个附件
且所有附件都是 ready
且没有正在提交的同一草稿
```

任一附件 uploading、failed 或 cancelled 时不可发送。失败卡片必须重试或移除，不能静默忽略。命令输入是否允许附件由现有命令语义单独判断；不能把附件悄悄丢掉后执行命令。

### 不可变发送快照

点击发送时创建快照：

- `inputId`；
- trim 规则处理后的文字；
- 按卡片顺序排列的 `assetId`、`intent: "auto"` 和 `displayName`；
- 用于 optimistic 展示的媒体类型和大小快照。

快照创建后不再引用可变草稿数组。用户切换会话或开始编辑下一条草稿，不会改变已提交内容。

`PendingPromptSubmission` 增加附件快照。`optimistic-transcript.ts` 为临时用户消息投影一个 text part 和按顺序排列的 attachment parts；文字为空时不生成空 text part。

### 已有会话

`prompt-actions.ts` 把快照传给 `window.desktop.sessions.sendPrompt`。Main 的 `session-service.ts` 不再只校验非空文字，而是校验“文字或附件至少一个”，随后把 ordered refs 传给 Client `admitPrompt`。

IPC resolved 只代表请求被 daemon 接收，不能伪造正式 transcript。权威 Snapshot/SSE 到达后，沿用当前 input ID 对账逻辑移除 pending submission。IPC 和 SSE 任意顺序都只能得到一组附件卡片。

### 新会话首条消息

新会话先创建和打开 session，再用同一 `sendPrompt` 快照发送。创建或打开失败时：

- 保留 `new-conversation` 的文字和附件草稿；
- 不清除 ready 卡片；
- 不重复上传资产；
- 重试时复用同一发送语义和稳定 input ID 规则。

创建成功后，草稿 scope 迁移到新 session，不能同时留在 `new-conversation` 和新 session 两份。

### 编辑最近消息

阶段 3 不支持改变已发送附件。进入编辑状态时：

- 原附件以只读 ready 卡片显示；
- 隐藏 picker、drop、paste 附件入口；
- 只允许修改文字；
- 重新提交时沿用原 ordered refs，不新增、不删除、不排序、不重复上传。

这与阶段 2 已支持的底层 edit 引用语义不冲突，但 Desktop 阶段 3 明确提供更窄的产品交互。

## Transcript 展示、预览与打开

历史消息的 `attachment` part 直接使用阶段 2 的快照字段，不依赖本地源文件。Renderer 根据媒体类型选择：

- 安全位图：缩略图卡片；
- SVG、HTML、XML、脚本、文档和其他格式：普通文件卡片；
- `transformation` part：预留处理状态、来源和错误展示槽位，但阶段 3 不生成它。

缩略图通过 Main 使用已鉴权 Client 下载 daemon 内容，再以受限字节结果交给 renderer 创建 Blob URL。不能暴露 daemon token，也不能构造未鉴权远程 URL。Blob URL 在卡片卸载、消息替换、会话切换或窗口关闭时 revoke。

“打开”先从 daemon 下载到应用管理的临时文件，再调用系统安全打开能力；“另存为”使用系统保存对话框。临时文件名使用安全展示名，写入位置、覆盖确认和清理由 Main 控制。Renderer 不调用 shell，也不拼接命令字符串。

原文件在上传成功后即不再参与预览、打开、排队运行或历史重建；用户删除原文件不影响 daemon 副本。

## 安全要求

1. Renderer 永远不接收完整本地路径、通用文件句柄、daemon token 或任意文件读取能力。
2. source token 与 `webContents.id` 绑定、一次性消费、短时过期，窗口关闭后全部失效。
3. Main 使用流读取，不把普通路径型文件整体缓冲到内存。
4. picker accept/filter、扩展名和 renderer 提供的 MIME 都不可信；daemon 做最终验证。
5. 文件名按纯文本渲染，不能进入 `dangerouslySetInnerHTML`。
6. SVG、HTML、XML 等主动内容不能进入 `img`、iframe、webview 或 renderer DOM 解析路径。
7. 预览白名单按实际安全位图媒体类型判断，而不是只看扩展名。
8. 打开和另存为必须通过 Main 的固定 API；任何路径都不能拼入 shell 命令。
9. 上传、下载和删除沿用 daemon 鉴权、资源归属、Range、ETag、`Content-Disposition` 和删除保护。
10. 对外错误使用稳定错误码和安全文案；底层路径、请求头和堆栈只进入受控日志。

## 错误处理

Desktop 错误至少区分：

- 用户取消选择；
- 目录或不支持的条目；
- 文件在上传前已不存在或不可读；
- 文件大小超限；
- daemon 拒绝媒体类型或检测到内容不一致；
- 网络中断、daemon 不可用或超时；
- 用户主动取消；
- 资产已被引用，不能逻辑删除；
- 预览失败、打开失败或另存为失败。

上传失败只修改对应卡片，不清除文字，也不影响其他 ready 卡片。可重试错误保留“重试”；确定不可重试的类型/大小错误只提供移除和重新选择。

daemon 重启或连接断开时，所有进行中的 Main 任务必须在有限时间内进入 failed/cancelled，不能永久停在 uploading。窗口关闭时不需要向已销毁 renderer 回送事件。

## 可访问性

- 每张附件卡片有包含文件名、类型、大小和状态的可读名称；
- 进度变化使用不会过度打扰的 live region，完成和失败才做明确通知；
- 取消、重试、移除、打开和下载都是可聚焦按钮，并有完整中文标签；
- 不只依赖颜色表达 uploading、ready 或 failed；
- 横向附件组支持键盘进入、左右移动和退出；
- drop target 出现时不抢走当前编辑焦点；
- 禁用的“添加文件夹”能让辅助技术读出“后续版本开放”。

## 功能开关

功能开放同时受 daemon capability 和 Desktop feature gate 控制：

- daemon 必须声明 `features.attachments: 1`、上传模式和 limits；
- 开发模式和自动化测试允许展示入口并走完整链路；
- 生产构建默认隐藏或禁用真正的附件发送，并说明功能尚未开放；
- 阶段 4 只用于内部验证原生图片路径；
- 阶段 5 验收后，图片附件才允许生产默认开启；
- 阶段 6 验收后，PDF、文本、代码和通用文件入口才允许生产默认开启；
- 阶段 8 才开放文件夹入口。

旧 daemon 不声明附件 capability 时，Desktop 保持纯文本行为，不发送它无法理解的新字段以外的附件操作。

## 竞态与一致性

必须固定以下竞态：

1. remove/cancel 后旧 upload success 到达：因 taskId 不匹配而忽略，并尝试清理未引用 asset。
2. retry 后旧 failure 到达：不能把新任务的卡片改回 failed。
3. 发送后用户立即切换会话：pending submission 仍归原 session runtime。
4. IPC resolved 先于 SSE：保留 optimistic，直到权威 input/message 到达。
5. SSE 先于 IPC resolved：先对账移除 optimistic，随后 IPC resolved 不能重新创建。
6. 新会话 create 成功但 open/send 失败：scope 只能归一个 session，草稿仍可重试。
7. 上传完成后源文件被删除：preview/download 使用 daemon 副本。
8. ready asset 被移除同时另一条消息已引用：`attachment_in_use` 不影响当前 UI 移除。

## 测试策略

### 共享类型与 contract

- Desktop prompt attachments 是有序必填数组；
- 纯附件允许，文字和附件全空拒绝；
- attachment/transformation part 从 daemon 到 renderer 类型不丢字段；
- IPC 输入、输出和事件拒绝路径、额外危险字段和非法状态；
- feature gate 与 capability 组合符合开放规则。

### Electron Main 与 preload

- picker 成功、用户取消、多选、目录拒绝和不可读文件；
- source token 的窗口绑定、一次性消费、过期和关闭清理；
- 流式上传、进度节流、取消、重试和错误映射；
- clipboard 无路径图片上传；
- preview、open、saveAs 不泄漏鉴权或路径；
- HTML/SVG 不能进入可执行预览路径。

### Renderer store

- `new-conversation` 与多个 session 的草稿完全隔离；
- 切换回来恢复文字、顺序和上传状态；
- 新会话创建后的 scope 原子迁移；
- 失败保留文字，移除只影响目标附件；
- `draftId + taskId` 丢弃所有迟到事件；
- ready 附件生成稳定、有序发送快照；
- pending submission 与 Snapshot/SSE 对账不重复；
- 编辑最近消息时附件只读且原引用保持。

### 组件

- picker、drag/drop、clipboard 进入同一卡片模型；
- image/file、uploading/ready/failed/cancelled 各状态；
- 取消、重试、移除、打开、下载操作；
- 多附件横向滚动和长文件名；
- 仅附件发送、上传未完成禁用发送；
- 预览失败降级；
- 键盘、焦点、ARIA label 和状态通知；
- “添加文件夹”图标保留且禁用。

### Desktop 集成

- picker → 上传 → send → optimistic → SSE → 历史重载；
- drag/drop 和 clipboard 图片得到与 picker 相同的 asset/message part；
- 新会话首条仅附件消息和已有会话一致；
- 上传失败、create/open/send 失败不清空草稿；
- 源文件删除后，排队消息、预览和下载仍使用 daemon 副本；
- IPC/SSE 的两种到达顺序都只有一组附件卡片；
- 主动 HTML/SVG 测试文件不能在 renderer 执行。

## 主要代码区域

- `apps/desktop/src/shared/session-types.ts`
- `apps/desktop/src/shared/desktop-api-contract.ts`
- `apps/desktop/src/preload/`
- `apps/desktop/src/main/features/attachment/`
- `apps/desktop/src/main/features/session/`
- `apps/desktop/src/renderer/src/stores/desktop-session/`
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/`
- `apps/desktop/src/renderer/src/components/ui/attachment.tsx`

## 阶段验收门槛

阶段 3 只有同时满足以下条件才算完成：

- picker、drag/drop 和 clipboard 图片能形成同一种 daemon asset 和 typed message part；
- 所有路径使用 Main 流式读取，renderer 无完整本地路径和通用文件系统能力；
- 每个 Composer/session 的附件草稿、任务和错误互不串用；
- 进度、取消、重试、移除和仅附件发送均可用；
- 新会话首条消息与已有会话走同一附件发送语义；
- 编辑最近消息只改文字，附件只读并保持原 ordered refs；
- 上传失败、会话创建失败和发送失败都不清空文字或可重试附件；
- IPC、请求返回、Snapshot 和 SSE 任意先后顺序都不会重复卡片；
- 原文件在上传成功后删除，历史预览、下载和排队输入仍然可用；
- HTML、SVG 和伪装扩展名内容不能在特权 renderer 中执行；
- 相关 contract、Main、preload、store、component、integration、typecheck 和文档检查全部通过；
- 开发模式完成全链路，生产默认发送入口保持关闭；
- 没有提前实现阶段 4 的模型路由或阶段 5 的 OCR。
