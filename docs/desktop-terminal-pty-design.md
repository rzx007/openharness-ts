# 设计：Desktop 右侧 Panel 终端 PTY

> 状态：设计稿，计划先实现本地终端 MVP，再扩展到沙箱终端。
>
> 日期：2026-08-15

## 背景

Desktop 右侧 panel 已经有审阅、终端、浏览器、文件、侧边聊天这些工具入口。终端目前还只是占位内容，下一步需要提供一个真正可交互的 PTY 终端，让用户能在当前项目目录里运行命令、启动开发服务、使用交互式命令行工具。

这里的 PTY 是 pseudo terminal，也就是“伪终端”。它的作用不是简单执行一个命令，而是让 `powershell`、`bash`、`vim`、`pnpm create`、选择器、彩色输出、清屏、光标移动这类交互式程序认为自己运行在真实终端中。

## 目标

- 在 Desktop 右侧 panel 内提供可用的终端 tab。
- 终端默认绑定当前项目目录，创建后在该目录作为 `cwd` 启动 shell。
- 支持输入、输出、窗口尺寸变化、关闭终端、进程退出提示。
- 终端 UI 跟随当前 light/dark 主题。
- 终端能力收在 Desktop 侧，第一版不改变 TUI 和 daemon session 的现有协议。
- 为后续本地 / 沙箱运行模式预留扩展点。

## 非目标

- MVP 不做远程共享终端。
- MVP 不持久化终端输出历史，避免误存 token、密码和敏感日志。
- MVP 不把终端接到 daemon 的对话 session 协议里。
- MVP 不做完整 shell profile 管理，只选择当前平台上最合理的默认 shell。
- MVP 不支持任意路径启动终端，只允许在已绑定项目目录内启动。

## 方案选择

推荐组合：

```text
Renderer: @xterm/xterm
Main:     node-pty
Bridge:   Electron IPC + preload 安全 API
Resize:   @xterm/addon-fit + ResizeObserver
Links:    @xterm/addon-web-links
```

`@xterm/xterm` 负责在前端渲染终端和处理键盘输入。它不是 shell，也不负责创建进程。它通常会连接到 PTY 后端，把用户输入写给 PTY，把 PTY 输出写回屏幕。

`node-pty` 负责在 Node/Electron main 侧启动真实 PTY。它能让很多交互式 CLI 正常工作，这是 `child_process.spawn` 做不到的。

Electron renderer 不直接加载 `node-pty`。渲染层只通过 preload 暴露的安全 API 和 main 进程通信。

## 总体结构

```text
apps/desktop/src/renderer/src/components/desktop/utility-panel.tsx
  -> terminal tab
  -> TerminalTool
       -> xterm Terminal
       -> FitAddon
       -> WebLinksAddon

apps/desktop/src/preload/desktop-api.ts
  -> window.desktop.terminal.create()
  -> window.desktop.terminal.write()
  -> window.desktop.terminal.resize()
  -> window.desktop.terminal.kill()
  -> window.desktop.terminal.onData()
  -> window.desktop.terminal.onExit()

apps/desktop/src/main/features/terminal/ipc.ts
  -> IPC channel registration

apps/desktop/src/main/features/terminal/terminal-service.ts
  -> create PTY
  -> write input
  -> resize PTY
  -> kill PTY
  -> cleanup by window/session/tab
```

运行流：

```text
用户打开右侧 panel 的终端 tab
  -> Renderer 创建 xterm 实例
  -> FitAddon 计算 cols/rows
  -> Renderer 调 terminal:create
  -> Main 校验 projectId 和项目目录
  -> Main 用 node-pty spawn shell
  -> PTY 输出通过 terminal:data event 推回 Renderer
  -> Renderer 调 xterm.write(data)

用户在终端输入
  -> xterm.onData(data)
  -> Renderer 调 terminal:write
  -> Main 调 pty.write(data)

Panel 尺寸变化
  -> ResizeObserver
  -> FitAddon.fit()
  -> Renderer 调 terminal:resize(cols, rows)
  -> Main 调 pty.resize(cols, rows)

用户关闭终端 tab
  -> Renderer 调 terminal:kill
  -> Main kill PTY 并释放事件监听
```

## IPC 设计

新增 channel：

```ts
export const IpcChannels = {
  terminalCreate: "terminal:create",
  terminalWrite: "terminal:write",
  terminalResize: "terminal:resize",
  terminalKill: "terminal:kill",
  terminalClear: "terminal:clear",
  terminalList: "terminal:list",
}

export const IpcEvents = {
  terminalData: "terminal:data",
  terminalExit: "terminal:exit",
}
```

共享类型：

```ts
export type DesktopTerminalRuntime = "local" | "sandbox"

export interface TerminalCreateInput {
  projectId: string
  runtime: DesktopTerminalRuntime
  cols: number
  rows: number
  shell?: string
}

export interface TerminalRecord {
  id: string
  projectId: string
  runtime: DesktopTerminalRuntime
  cwd: string
  shell: string
  cols: number
  rows: number
  createdAt: string
  exitedAt?: string
  exitCode?: number
}

export interface TerminalWriteInput {
  terminalId: string
  data: string
}

export interface TerminalResizeInput {
  terminalId: string
  cols: number
  rows: number
}

export interface TerminalDataEvent {
  terminalId: string
  data: string
}

export interface TerminalExitEvent {
  terminalId: string
  exitCode: number | null
}
```

preload 暴露：

```ts
window.desktop.terminal = {
  create(input),
  write(input),
  resize(input),
  kill(terminalId),
  list(),
  onData(listener),
  onExit(listener),
}
```

## 项目目录绑定

终端不能只信任 renderer 传入的 `cwd`。创建终端时 renderer 只传 `projectId`，main 侧根据项目存储查当前绑定目录：

```text
projectId -> project_location.active -> path -> fs.stat(path)
```

如果目录存在：

```text
spawn shell with cwd = project path
```

如果目录不存在：

```text
拒绝创建终端
Renderer 显示“项目目录不可用”
提供“重新绑定目录”入口
```

这样用户移动项目目录后，不需要删除项目记录。重新绑定目录后，新开的终端使用新目录。已经存在的终端继续保持自己的原始 `cwd`，这更接近 IDE 的行为，也避免正在运行的命令被突然迁移。

## 本地和沙箱运行模式

MVP 只实现本地：

```ts
runtime: "local"
```

但是 `TerminalCreateInput` 保留 `runtime` 字段，后续可以接入沙箱：

```ts
interface TerminalProvider {
  create(input: TerminalCreateInput): Promise<TerminalRecord>
  write(input: TerminalWriteInput): void
  resize(input: TerminalResizeInput): void
  kill(terminalId: string): void
}
```

第一版：

```text
LocalTerminalProvider
  -> Electron main
  -> node-pty
  -> host project cwd
```

后续：

```text
SandboxTerminalProvider
  -> daemon/server
  -> websocket 或 SSE + command channel
  -> container PTY
  -> /workspace
```

沙箱终端应该复用现有 sandbox runtime 的边界和项目挂载规则，不在 Desktop 里单独复制一套 sandbox 逻辑。

## Shell 选择

Windows：

```text
1. pwsh.exe
2. powershell.exe
3. cmd.exe
```

macOS / Linux：

```text
1. process.env.SHELL
2. /bin/zsh
3. /bin/bash
4. /bin/sh
```

环境变量从 `process.env` 复制，不重新手写一份。特别是 Windows 上不能丢掉 `SystemRoot`，否则 PowerShell 可能启动失败。

可以额外补充：

```ts
{
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  FORCE_COLOR: "1",
}
```

## 生命周期

TerminalService 内部维护：

```ts
type TerminalSession = {
  id: string
  webContentsId: number
  projectId: string
  runtime: "local"
  cwd: string
  shell: string
  pty: IPty
  createdAt: Date
}
```

清理规则：

- 关闭 terminal tab：kill 对应 PTY。
- 关闭右侧 panel：不自动 kill，除非 terminal tab 被关闭。
- 切换 active tab：不 kill，保持命令继续运行。
- 主窗口关闭：kill 该窗口创建的所有 PTY。
- app before-quit：kill 全部 PTY。
- PTY 自己退出：发送 `terminal:exit`，renderer 显示退出码和重启入口。

## 输出节流

PTY 输出可能很密集，main 不应该每个 chunk 都立即发 IPC。可以按 terminalId 做短缓冲：

```text
pty.onData(data)
  -> append buffer
  -> if not scheduled, schedule flush after 16ms
  -> webContents.send("terminal:data", { terminalId, data: joined })
```

这样可以降低 IPC 压力，同时用户体感仍然接近实时。

## Renderer 组件设计

`TerminalTool` 负责：

- 创建和销毁 xterm。
- 根据主题生成 xterm theme。
- 通过 `ResizeObserver` 做 fit 和 resize。
- 把 `xterm.onData` 发送给 main。
- 监听 `terminal:data` 和 `terminal:exit`。
- 当前项目不可用时显示空状态和重新绑定入口。

基本 UI：

```text
右侧 panel header
  tab: 终端

terminal content
  顶部可选工具条：shell 名称 / cwd / clear / restart
  主区域：xterm canvas/dom
  退出状态：进程已退出，exit code = n，重新启动
```

主题：

```ts
light: {
  background: "transparent or panel background",
  foreground: CSS var(--foreground),
  cursor: CSS var(--foreground),
  selectionBackground: ...
}

dark: {
  background: "transparent or panel background",
  foreground: CSS var(--foreground),
  cursor: CSS var(--foreground),
  selectionBackground: ...
}
```

不要给终端再套重卡片。它应该像文件/浏览器一样成为 panel 内的工具表面。

## 安全边界

- Renderer 不加载 `node-pty`。
- Browser tool 的 `webview` 不能访问 `window.desktop.terminal`。
- Main 创建终端前校验 `projectId` 和项目目录。
- TerminalService 记录 `webContentsId`，write/resize/kill 只能操作当前窗口创建的终端。
- 不持久化输出。
- 不向远端暴露本地 PTY。
- 后续做 sandbox/remote terminal 时，必须经过 daemon 权限模型和运行边界。

`node-pty` 启动出来的进程拥有当前应用用户的权限，所以它本质上等价于用户在本机终端里执行命令。产品上要把它当成本地高权限能力处理。

## 打包和依赖风险

`node-pty` 是 native module，安装和打包比普通 npm 包更敏感。

当前 Desktop 已有：

```json
"postinstall": "electron-builder install-app-deps"
```

新增依赖后需要验证：

```bash
pnpm --filter @openharness/desktop run typecheck
pnpm --filter @openharness/desktop run build
pnpm --filter @openharness/desktop run start
```

Windows 上如果 `node-pty` 编译失败，通常需要检查：

- Visual Studio Build Tools。
- Windows SDK。
- Electron ABI rebuild。
- `electron-builder install-app-deps` 是否执行成功。

## 分阶段实现

第一批：本地终端 MVP

- 新增依赖：`@xterm/xterm`、`@xterm/addon-fit`、`@xterm/addon-web-links`、`node-pty`。
- 新增 `terminal-types.ts`。
- 新增 main `terminal-service.ts` 和 `ipc.ts`。
- preload 暴露 `window.desktop.terminal`。
- `UtilityPanel` 把 terminal placeholder 替换为 `TerminalTool`。
- 支持 create、write、data、resize、kill、exit。
- cwd 使用当前项目绑定目录。

第二批：体验完善

- 支持多个终端 tab。
- 支持 clear、restart、copy selected text、paste。
- 项目目录不可用时接入重新绑定。
- 终端退出后展示 exit code 和重启入口。
- 细化 light/dark 主题。
- 保存每个项目的默认 shell。

第三批：沙箱终端

- 抽象 `TerminalProvider`。
- 新增 `SandboxTerminalProvider`。
- 通过 daemon/server 连接容器 PTY。
- 和开始页的“本地 / 沙箱”运行模式统一。
- 明确 sandbox terminal 的权限提示、网络策略和文件边界。

## 参考资料

- xterm.js: https://github.com/xtermjs/xterm.js
- xterm.js addons: https://xtermjs.org/docs/guides/using-addons/
- node-pty: https://github.com/microsoft/node-pty
- Electron utilityProcess: https://www.electronjs.org/docs/latest/api/utility-process
