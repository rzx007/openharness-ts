# 设计：TUI 渲染尾巴（E.3 收尾）

> 状态：已批准。E.3 剩余三项体验：语法高亮、TUI output-style render-branch、
> tool 行分组折叠。纯前端/渲染层，零协议变更。

## R1 — 代码块语法高亮

- 依赖 `cli-highlight`（highlight.js + chalk ANSI 输出）进 catalog + frontend。
- `Markdown.tsx` 的 `case "code"`：`highlight(text, { language: lang,
  ignoreIllegals: true })` 后按行 `<Text>{line}</Text>`——Ink 透传 ANSI 转义。
- 未知/坏语言名（ignoreIllegals 兜不住时 try/catch）回退无色纯文本。
- **无 lang 的围栏不做 auto-detect**（highlight.js 会给纯文本/日志乱着色），
  原样返回并保留主题 accent 色（审查后定型）。
- REPL（EventRenderer）无 markdown 渲染路径（assistant 文本原样直出），
  本轮不动——差异记录：高亮仅 TUI。

## R2 — TUI output-style render-branch

- 现状：TUI 只在 state 里跟踪 `output_style`，渲染不分支（output-styles
  设计文档明确记过的坑）。
- App 从 `status.output_style` 取样式名 → 传 `ConversationView` /
  `ToolCallDisplay`；`minimal` 分支：工具行无图标无边框，`> name summary`
  纯文本风（与 REPL renderer.ts 的 minimal 语义一致）；default/codex 现状。
- backend 的 `/output-style` 命令执行后 emit 一次 `state_snapshot`，
  让 TUI 热切换即时生效（核对现有命令路径是否已发，缺则补）。

## R3 — tool 行分组折叠

- `ConversationView` 把 transcript 里**连续的 tool/tool_result 项**分组：
  - 最新一组（仍可能在进行中）保持展开；
  - 更早的组折叠为一行摘要：`▸ N 个工具调用（Read, Grep, Bash…）`，
    名字去重、最多列 5 个；
- 纯展示折叠（无键盘展开交互——Ink 的 transcript 不是可聚焦列表，留待）。
- TS 自有 UX（Python TUI 形态不同），设计记录即依据。

## 测试

- R1：高亮输出含 ANSI 转义、未知语言回退、无 lang 代码块不崩
  （沿 Markdown.test.tsx / markdownParser.test.ts 既有 ink-testing 约定）。
- R2：minimal 下 ToolCallDisplay 快照无图标；style 变更经 state 流入重渲染。
- R3：分组函数纯逻辑单测（连续 tool 分组/最新组展开/摘要文案）。
