# 结构化输入框与多能力引用设计

## 目标

让 OpenHarness Desktop 的输入框对齐当前 Codex 桌面体验：用户可以在正文任意合法词边界输入 `/` 或 `$` 打开选择菜单，将一个或多个 Skill 作为无胶囊的行内引用插入正文；发送、排队、重试、编辑、历史恢复和会话投影都保留这些引用的结构与顺序。

本次不再扩展“正文开头只能有一个 `/skill`”的旧模型，而是建立可以继续承载 App、插件、文件和其他资源引用的长期输入协议。

## 已确认的交互

### `/` 与 `$`

- `/` 和 `$` 都可以在文档开头、空白字符之后或原子引用节点之后触发，不限制在整段输入开头。
- 菜单查询范围是光标所在的当前 token。例如 `帮我用 /wri| 写计划` 只替换 `/wri`，不改动前后正文。
- `/` 打开混合菜单，包含应用命令和已启用的 Skill。
- `$` 打开能力引用菜单。本次展示 Skill，并为 App、插件和资源引用保留扩展类型。
- 从 `/` 或 `$` 选择同一个 Skill，最终都插入同一种结构化 Skill 节点。
- 选择 Skill 后不发送消息；光标落在引用之后，并保证与相邻内容之间存在一个可继续输入的空格。
- 同一个 Skill 可以多次出现在正文中。编辑器不主动去重，因为重复引用及其位置属于用户输入；服务端加载指令时可以按规范化路径去重，避免重复加载同一份 `SKILL.md`。
- `Escape` 关闭菜单但保留已输入 token；继续修改 token 后菜单可以重新出现。
- `ArrowUp`、`ArrowDown` 移动菜单选项，`Enter` 或 `Tab` 选中，鼠标点击也可选中。

### 命令与能力的区别

菜单条目使用显式联合类型，不再把所有 catalog entry 都当成提示词模板：

```ts
type ComposerPickerItem =
  | { kind: "command"; command: SessionCommandDescriptor }
  | { kind: "skill"; skill: ComposerSkillReference }
  | { kind: "mention"; mention: ComposerMentionReference }
```

- `command` 是应用动作，例如切换 Plan、选择模型或开始 Review。选择后交给命令处理器，不进入用户消息。
- `skill` 和 `mention` 是用户消息内容。选择后替换当前 token，成为行内原子节点。
- `/` 可以返回 `command | skill`；`$` 可以返回 `skill | mention`。
- 菜单可以共享过滤、键盘选择和定位逻辑，但数据源与选中后的动作必须分开。

## 视觉设计

采用已选择的 A 方案，接近 Codex：

- Skill 引用由 14px 能力图标和显示名称组成。
- 使用现有语义化 `primary` 前景色，名称使用中等字重。
- 没有背景、边框、圆角、内边距或胶囊轮廓。
- 引用与正文共享行高并按文字基线对齐；长名称允许在输入框边界内截断，但节点整体不可拆分编辑。
- hover 只做轻微前景色变化并显示来源说明，不增加背景块。
- focus/键盘选中状态使用可见的文本下划线或 outline，不能只靠颜色表达状态。
- transcript 中的已发送消息使用同一套行内样式，不再额外显示顶部 Skill 胶囊。

## 数据模型

### 编辑器文档

输入框状态不再以 `draft: string` 作为唯一事实来源。新增可序列化的文档模型：

```ts
interface ComposerDocument {
  version: 1
  items: ComposerInputItem[]
}

type ComposerInputItem =
  | { type: "text"; text: string }
  | {
      type: "skill"
      name: string
      path: string
      displayName: string
      source?: "bundled" | "user" | "project" | "plugin"
    }
  | {
      type: "mention"
      name: string
      path: string
      displayName: string
    }
  | {
      type: "attachment"
      attachmentId: string
      displayName: string
    }
```

约束：

- 相邻 `text` item 在序列化时合并；空文本不保存。
- `skill.path` 是引用身份，`name` 和 `displayName` 用于提交文本与展示。
- `mention.path` 使用可扩展 URI，例如未来的 `app://...`、`plugin://...` 或文件资源 URI。
- attachment item 引用现有附件记录，不复制二进制内容。
- 文档顺序就是用户表达顺序，所有层都不得按类型重新排序。

### Session 输入协议

新增通用 `SessionUserInputItem`，由 client、server、desktop 共同使用：

```ts
type SessionUserInputItem =
  | { type: "text"; text: string }
  | { type: "skill"; name: string; path: string; displayName?: string; source?: SkillSource }
  | { type: "mention"; name: string; path: string; displayName?: string }
  | { type: "attachment"; attachmentId: string }
```

`SendDesktopPromptInput`、`EditLatestDesktopPromptInput` 和创建 Session 的第一条输入改为接收 `items`。原有 `content`、`attachments` 和单数 `skillInvocation` 在兼容期继续允许读取，但新 UI 不再写入单数 metadata。

`SessionInputRecord` 增加 `items` 并保留派生的 `content`：

- `items` 是持久化和恢复的事实来源。
- `content` 是把 text、`$skill-name` 和可读 mention 占位串联后的兼容文本，用于标题、搜索、旧客户端和纯文本导出。
- attachment 记录继续使用现有存储与上传生命周期，item 只保存引用和位置。

### 服务端展开

服务端在一次 run 被接纳后，将结构化输入解析成 agent/provider 可消费的内容：

1. 校验所有 item 的类型、长度和字段格式。
2. 按规范化绝对路径解析 Skill，拒绝消息提交后被替换到其他文件的路径。
3. 按首次出现顺序收集 Skill；执行加载时按路径去重。
4. 保留用户正文中的 `$skill-name` 可读标记。
5. 将 Skill 引用作为明确的结构化选择交给运行时；不再为每个 Skill 嵌套生成“请先使用 Skill 工具”的提示词。
6. 当前 agent adapter 如果暂时只接受文本，则由单一兼容适配器生成一次集中指令；兼容逻辑不能散落在 Desktop、Session service 和各 provider 中。
7. attachment item 在对应位置展开成现有 `ContentBlock`；不支持位置语义的 provider 可以保持附件顺序并在文本后传递。

兼容适配器的临时文本形态为：

```text
用户显式选择了以下技能，请按出现顺序加载并遵循：
1. using-superpowers (<absolute SKILL.md path>)
2. writing-plans (<absolute SKILL.md path>)

用户输入：
使用 $using-superpowers 写个计划 $writing-plans
```

## Lexical 编辑器设计

### 节点

- 将现有 `SkillCommandPillNode` 更名为表达用途的 `SkillMentionNode`。
- 节点保存 `name`、`path`、`displayName`、`source`，导出 JSON 时包含稳定版本号。
- `getTextContent()` 返回 `$name`，保证复制到纯文本、搜索和降级展示仍有意义。
- 节点是行内原子元素：不能把光标放入名称内部，Backspace/Delete 一次删除整个节点，左右方向键可以越过节点。
- 后续新增 `ResourceMentionNode` 时复用相同的序列化接口和视觉组件。

### 编辑器与外部状态同步

- Lexical editor state 是编辑期事实来源；每次更新通过纯函数导出 `ComposerDocument` 给 Zustand 草稿 store。
- 外部恢复草稿时，从 `ComposerDocument` 重建 Lexical 节点，不再通过解析一个字符串猜测 Skill。
- 输入框初始化、切换 Session、提交成功清空、提交失败保留、历史恢复和编辑最新消息都使用同一套 document codec。
- 纯文本粘贴不会凭 `$name` 自动创建 Skill；只有从菜单明确选中的条目才带可信路径并成为结构化节点。
- 从应用内部复制再粘贴时，优先读取自定义 MIME 中的结构化节点；外部应用只能得到 `$name` 纯文本。

### token 识别

新增纯函数根据当前文档和 selection 返回触发信息：

```ts
interface ComposerTrigger {
  sigil: "/" | "$"
  query: string
  range: { start: number; end: number }
}
```

规则：

- 只检查当前光标所在的普通文本节点。
- token 起点必须是文档开头、空白之后或原子节点之后。
- query 不跨越空白、换行或原子节点。
- `/`、`$` 后尚无字符时 query 为空并显示完整列表。
- 光标移入 token 中间时，只替换该 token 的查询范围，保留后缀正文。
- IME 组合输入期间不打开、过滤或提交菜单，组合结束后再同步。

## 菜单设计

- 将 `SkillCommandMenu` 拆为通用 `ComposerPicker` 和数据源适配器。
- 菜单锚定当前 token，而不是固定覆盖整个 composer；空间不足时允许退化为输入框宽度。
- `/` 菜单按命令、Skill 分组；`$` 菜单按 Skill、未来的 App/资源分组。
- 搜索字段包括 name、displayName、description 和来源，但插入身份始终使用精确 path。
- 同名不同路径的 Skill 都可展示，显示来源辅助信息；项目版本排在用户、插件和内置版本之前。
- 没有结果时显示安静的空状态；不会阻止用户继续把 `/...` 或 `$...` 当普通文字发送。

## 数据流

```text
键盘输入
  → Lexical 文本/原子节点
  → 光标 token 解析
  → / 或 $ 菜单
  → 选择命令：交给命令处理器，不写入消息
  → 选择能力：替换 token 为结构化节点
  → ComposerDocument 保存到草稿 store
  → 提交时转换为 SessionUserInputItem[]
  → Session event/store 持久化 items，同时派生 content
  → run executor 解析 Skill 与附件
  → agent adapter 获得结构化输入或统一兼容展开结果
  → transcript 从 items 还原正文和行内引用
```

## 兼容与迁移

- 旧输入若只有 `content`，恢复为单个 text item。
- 旧输入若同时带 `metadata.skillInvocation`，在读取投影时转换成位于正文开头的 skill item，再接正文 text item；数据库原记录不做破坏性重写。
- 新写入只使用 `items`，同时生成 `content` 兼容字段。
- API 和 event payload 增加明确版本；旧 client 仍可在兼容期提交旧字段。
- 单数 `SkillInvocationMetadata`、`parseSelectedSkillCommandDraft`、`parseSkillCommandInvocation` 和 `applySkillInvocationToContent` 在所有调用方迁移后删除。
- `/skill-name` 旧草稿只在一次性恢复 codec 中识别；用户新输入的普通 `/skill-name` 不通过字符串猜测转换成可信 Skill。

## 错误处理与安全

- 提交前发现 Skill 已删除或路径不可读时，保留草稿并把对应引用标为失效，提示用户移除或重新选择。
- server 重新验证 path 必须属于当前 cwd 可发现的 Skill catalog，不能信任 renderer 传入的任意文件路径。
- 名称和显示名称限制长度并过滤控制字符；路径不进入 HTML title 的未转义内容。
- 未识别的 `/` 或 `$` token 始终作为普通文本，不阻塞正常发送。
- 排队、steer 和 edit 使用同一套校验，避免直接发送与排队发送行为不一致。

## 测试策略

### 纯函数与协议

- 光标在开头、空格后、原子节点后输入 `/` 或 `$` 都能产生正确 trigger。
- 单词内部、URL、转义文本和 IME 组合期间不误触发。
- 选中项只替换当前 token，正文前后保持不变。
- 多个 text/skill/mention/attachment item 往返序列化后顺序和字段不丢失。
- 兼容文本按原顺序生成 `$skill-name`，相邻 text 正确合并。
- 同名不同 path 不混淆；服务端只按 path 去重完全相同的 Skill。

### 组件

- `/` 菜单包含命令和 Skill，`$` 菜单不包含应用命令。
- 键盘导航、Escape、Enter、Tab、鼠标选择符合定义。
- Skill 引用没有背景、边框、圆角和胶囊内边距，使用语义化 primary 色。
- Backspace/Delete、左右移动、复制粘贴和内部结构化粘贴保持原子节点行为。
- IME 输入不会误提交或让菜单抢走按键。

### Session 全链路

- 新会话、已有会话、queue、steer、retry、edit latest 均保留多个引用。
- optimistic transcript 与服务端 transcript 结构一致，不在确认后闪烁或改变顺序。
- 旧 `skillInvocation` 记录可正常读取，新记录不再写入该字段。
- Skill 删除、路径越界和无效字段返回可恢复错误，草稿不丢失。
- 文本-only、带多个 Skill、仅 Skill、Skill 加附件以及多附件穿插场景都有覆盖。

## 实施切片

1. 定义 `ComposerDocument`、`SessionUserInputItem`、codec 和旧数据兼容读取，先完成纯函数测试。
2. 将草稿 store 和 Session API 迁移到结构化 items，打通持久化、排队、重试和编辑。
3. 重构 Lexical 节点与光标 token 解析，实现 `$` 能力菜单和多个 Skill。
4. 将 `/` 菜单改成命令与 Skill 的混合数据源，并按条目类型分流。
5. 改造服务端 run 展开和 Skill 路径校验，删除分散的单 Skill prompt 注入。
6. 从 items 渲染 optimistic/confirmed transcript，应用无胶囊行内样式。
7. 删除迁移完成后的单 Skill 生产路径，运行 Desktop、client、protocol、services、server 相关测试和全仓类型检查。

## 非目标

- 本次不实现新的 App、插件或云资源连接器，只保留 `mention` 协议和菜单扩展点。
- 不自动把用户手打或粘贴的 `$name` 提升为可信 Skill。
- 不改变 Skill 的发现目录、优先级或安装流程。
- 不改变具体应用命令的业务效果，只调整菜单触发、分类和分流。

## 验收标准

- 用户可在正文任意合法 token 边界通过 `/` 或 `$` 添加多个 Skill。
- 两种入口生成同一种结构化 Skill item，并保留精确路径与出现顺序。
- `/` 中的应用命令仍作为动作处理，不混入模型输入。
- 输入框和 transcript 的 Skill 均为蓝色图标加名称，无胶囊视觉。
- 发送、排队、重试、编辑和历史恢复不丢失引用。
- 新数据走结构化 items，旧单 Skill 会话继续可读。
- 服务端不信任 renderer 路径，并集中处理 Skill 加载与兼容展开。
