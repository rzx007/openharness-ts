# 设计：Desktop 右侧 Panel 终端 PTY

> 状态：本地用户终端、Agent 持久终端、Desktop 挂接、daemon 传输、右键菜单、每项目默认 shell 和沙箱终端 MVP 均已实现。
>
> 日期：2026-08-15

## 背景

Desktop 右侧 panel 已经提供可交互的 PTY 终端。用户可以在当前项目目录里运行命令、启动开发服务和使用交互式命令行工具；Agent 也可以创建自己的持久终端，随后由用户从对话卡片打开并接管。

这里的 PTY 是 pseudo terminal，也就是“伪终端”。它的作用不是简单执行一个命令，而是让 `powershell`、`bash`、`vim`、`pnpm create`、选择器、彩色输出、清屏、光标移动这类交互式程序认为自己运行在真实终端中。

## 功能说明

### 当前功能

| 功能            | 状态   | 实际行为                                                                         |
| --------------- | ------ | -------------------------------------------------------------------------------- |
| 用户终端        | 已实现 | 用户从 Desktop 右侧 Panel 创建、输入、切换、清屏、重启和关闭终端。               |
| 多终端          | 已实现 | 同一项目可以同时打开多个终端，并通过顶部 tab 切换。                              |
| Agent 持久终端  | 已实现 | Agent 创建长期运行的 PTY，用于开发服务器、watch、REPL、调试器和交互式 CLI。      |
| 对话卡片挂接    | 已实现 | `TerminalOpen` 成功后显示终端卡片，点击“打开终端”会展开右侧 Panel 并附着原 PTY。 |
| 输出恢复        | 已实现 | Panel 重新打开或切换终端时先读取内存快照，再接续 SSE 实时输出。                  |
| 进程状态        | 已实现 | 记录 `running`、`exited`、退出时间和退出码；进程退出后仍可查看最后输出。         |
| 项目目录        | 已实现 | 用户终端从当前项目绑定目录启动；目录失效时引导用户重新绑定项目。                 |
| 项目默认 shell  | 已实现 | 项目记录持久化 `defaultShell`；新建本地终端时按项目带入 shell，留空则使用系统默认。 |
| 右键菜单        | 已实现 | xterm 区域支持复制选区、粘贴、清空、重启和关闭。                                |
| light/dark 主题 | 已实现 | xterm 配色跟随 Desktop 主题。                                                    |
| 本地运行        | 已实现 | `LocalTerminalProvider` 通过 `node-pty` 创建本机 PTY。                           |
| 沙箱运行        | MVP 已实现 | 复用 `runtime: "sandbox"` 和现有 sandbox runtime。当前是 pipe-backed interactive shell，不承诺完整 PTY 行编辑和尺寸语义。 |

### Agent 工具

| 工具 | 用途 | 权限属性 |
| --- | --- | --- |
| `TerminalOpen` | 在当前 Agent 的 `cwd` 创建持久终端并返回 `jobId`。 | 执行类操作，需要现有权限流程批准。 |
| `JobSend` | 向运行中的终端写入文本或控制字符。 | 写入类操作，需要批准。 |
| `JobRead` | 读取终端当前状态、增量输出和 cursor。 | 只读。 |
| `JobWait` | 等待终端退出或本次等待超时；超时不会关闭终端。 | 只读。 |
| `JobCancel` | 终止终端。 | 执行类操作，需要批准。 |
| `JobList` | 列出当前 Agent session 拥有的终端 Job。 | 只读。 |

Agent 不应该用持久终端替代所有命令执行。一次性的构建、测试、查询和脚本仍优先使用 `Bash`；只有进程需要持续运行、需要多轮输入，或者需要用户后续接管时才使用 Terminal 工具。

`JobSend` 会原样写入 `data`。提交命令时发送终端 Enter 字符 `\r`；需要中断或 EOF 时分别发送 `\u0003` 或 `\u0004`。终止整个终端使用 `JobCancel`。

`JobRead` 默认最多向模型返回 12000 个字符，避免大量日志占满模型上下文。Desktop 使用的完整内存快照上限约为 20 万字符，不写入数据库。

### Desktop 操作

用户可以通过两种方式进入终端：

1. 在右侧工具 Panel 中添加“终端”，手动创建用户终端。
2. 点击 Agent 回复中的终端卡片，打开 Agent 已经创建并正在运行的终端。

关闭右侧 Panel 只会隐藏视图并断开当前渲染订阅，不会结束 PTY。关闭具体终端 tab 会调用终端关闭接口并结束对应 PTY。切换项目时，终端记录仍按 `projectId` 隔离显示。

### HTTP API

Desktop main 通过 `OpenHarnessClient` 调用 daemon，不直接持有 PTY：

| 方法     | 路径                            | 作用                                                    |
| -------- | ------------------------------- | ------------------------------------------------------- |
| `POST`   | `/terminals`                    | 创建用户终端。                                          |
| `GET`    | `/terminals`                    | 按 `projectId`、`sessionId` 或 `source` 列出终端。      |
| `GET`    | `/terminals/:terminalId`        | 获取终端状态。                                          |
| `GET`    | `/terminals/:terminalId/output` | 读取输出快照、sequence 和截断状态。                     |
| `POST`   | `/terminals/:terminalId/input`  | 写入终端输入。                                          |
| `POST`   | `/terminals/:terminalId/resize` | 更新 PTY 的行列尺寸。                                   |
| `POST`   | `/terminals/:terminalId/signal` | 发送中断、EOF 或终止信号。                              |
| `DELETE` | `/terminals/:terminalId`        | 关闭并移除终端。                                        |
| `GET`    | `/terminals/stream`             | 通过 SSE 推送 `data`、`exit`、`title` 和 `error` 事件。 |

所有 HTTP 路由都复用 daemon 现有 Bearer token 认证。Terminal SSE 会在 daemon 关闭时先主动断开，避免长连接阻塞 HTTP server 退出。

### 数据和生命周期

- daemon 是 PTY、终端状态和输出快照的唯一所有者。
- Desktop main 只负责 Electron IPC 与 HTTP/SSE 之间的转发。
- 终端记录和输出只保存在 daemon 内存中，daemon 重启后不会恢复。
- 会话 transcript 只保存 Agent 的工具调用和精简工具结果，不保存完整终端日志。
- 关闭 renderer 或 Desktop Panel 不结束终端；关闭具体终端或 daemon 才会回收 PTY。
- daemon 退出顺序是：停止 Agent、关闭 Session/Terminal SSE、回收全部 PTY、关闭数据库和 HTTP listener。

### 所有权边界

- 用户终端使用 `source: "user"`；Agent 终端使用 `source: "agent"`。
- Agent 终端同时记录创建者的 `sessionId`。
- Agent 只能操作 `source: "agent"` 且 `sessionId` 与当前 Agent 完全一致的终端。
- 子 Agent 使用自己的 session id，不能读写父 Agent 或兄弟 Agent 的终端。
- Agent 当前不能读写用户手动创建的终端；Desktop 用户可以查看和接管 Agent 终端。

## 目标

- 在 Desktop 右侧 panel 内提供可用的终端 tab。
- 终端默认绑定当前项目目录，创建后在该目录作为 `cwd` 启动 shell。
- 支持输入、输出、窗口尺寸变化、关闭终端、进程退出提示。
- 终端 UI 跟随当前 light/dark 主题。
- 终端 runtime 由 daemon 持有；Desktop 和 Agent 通过公共客户端接入，TUI 的界面与既有会话流程不需要改动。
- 支持本地 / 沙箱运行模式切换；Desktop 只传 `runtime`，实际 runtime 选择和边界由 daemon/server 持有。

## 非目标

- MVP 不做远程共享终端。
- MVP 不持久化终端输出历史，避免误存 token、密码和敏感日志。
- 终端输出不写入会话数据库，只把 Agent 工具调用和精简结果写入 transcript。
- 当前版本不提供完整终端 Profile 配置界面。用户可以为每个项目设置一个默认 shell，但还不能维护 `PowerShell`、`pwsh`、`cmd`、`Git Bash`、自定义启动参数和环境变量这些成套预设。
- MVP 不支持任意路径启动终端，只允许在已绑定项目目录内启动。

## 方案选择

当前实现组合：

```text
Renderer: @xterm/xterm
Runtime:  daemon + @openharness/terminal-node + node-pty / @openharness/sandbox
Network:  REST commands + SSE output
Desktop:  Electron IPC + preload 安全 API + OpenHarnessClient + Electron clipboard
Resize:   @xterm/addon-fit + ResizeObserver
Links:    @xterm/addon-web-links
```

`@xterm/xterm` 负责在前端渲染终端和处理键盘输入。它不是 shell，也不负责创建进程。它通常会连接到 PTY 后端，把用户输入写给 PTY，把 PTY 输出写回屏幕。

`node-pty` 由 daemon 内的 `LocalTerminalProvider` 懒加载并启动真实 PTY。它能让很多交互式 CLI 正常工作，这是 `child_process.spawn` 做不到的。

`runtime: "sandbox"` 也走同一个 `LocalTerminalProvider` 接口，但内部复用 `@openharness/sandbox` 的 `startSandboxRuntime()` 与 `createShellProcess()`。当前它是 pipe-backed interactive shell，适合基础命令和输出查看；完整 PTY 交互后续在 sandbox backend 有稳定 pseudo-terminal 能力时再替换。

Electron renderer 和 Desktop main 都不直接加载 `node-pty`。渲染层只通过 preload 暴露的安全 API 与 main 通信，main 再通过 `OpenHarnessClient` 连接 daemon。

## 分层和可移植性

终端能力本身不应该绑定 Desktop 右侧 panel。Desktop panel 只是第一个宿主，真正可复用的是“创建终端、传输输入输出、调整尺寸、关闭进程、同步退出状态”这一套能力。

推荐把设计分成五层：

```text
Terminal Core
  纯类型和协议层，不依赖 Electron、React、xterm、node-pty。
  定义 TerminalSession、TerminalEvent、TerminalProvider、TerminalConnection。

Terminal Runtime
  真正创建和管理 PTY。
  Local runtime 用 node-pty。
  Sandbox runtime 后续走 daemon/server/container PTY。

Terminal Transport
  把 terminal events 从 runtime 送到 UI。
  Desktop 第一版用 Electron IPC。
  Web/remote 后续可以用 WebSocket。
  测试可以用 in-memory transport。

Terminal View
  终端 UI 组件。
  React 版本使用 @xterm/xterm。
  组件只依赖 TerminalConnection，不关心后面是 Electron IPC 还是 WebSocket。

Host Integration
  宿主集成层。
  Desktop 负责 panel tab、项目目录、重新绑定目录、主题、窗口生命周期。
  其他宿主可以替换这一层。
```

核心方向是：

```text
UI 不知道 node-pty。
Runtime 不知道 React。
Core 不知道 Electron。
Desktop 只负责把项目和窗口生命周期接进去。
```

这样拆开之后，同一个终端能力可以被多个地方复用：

```text
Desktop panel terminal
  -> Electron IPC transport
  -> LocalTerminalProvider

Web terminal
  -> WebSocket transport
  -> DaemonTerminalProvider

Sandbox terminal
  -> WebSocket transport
  -> SandboxTerminalProvider

测试
  -> InMemoryTerminalConnection
  -> FakeTerminalProvider
```

### 建议的代码边界

MVP 可以先保持实现简单，但文件结构要按可迁移边界写：

```text
packages/terminal
  src/types.ts
  src/provider.ts
  src/connection.ts
  src/events.ts

packages/terminal-node
  src/local-terminal-provider.ts
  src/shell.ts
  src/output-buffer.ts

apps/desktop/src/main/features/terminal
  ipc.ts
  desktop-terminal-service.ts

apps/desktop/src/renderer/src/components/desktop/tools/terminal
  terminal-tool.tsx
  terminal-view.tsx
  xterm-theme.ts
```

如果暂时不想新增 package，也至少按同样的边界组织在 `apps/desktop` 内部，避免把 `node-pty`、Electron IPC、React/xterm 写进同一个文件。后续要抽包时，移动成本会低很多。

### Core 类型示意

核心层只描述终端行为：

```ts
export type TerminalRuntime = "local" | "sandbox";

export interface TerminalCreateRequest {
  projectId: string;
  runtime: TerminalRuntime;
  cols: number;
  rows: number;
  shell?: string;
}

export interface TerminalSessionInfo {
  id: string;
  projectId: string;
  runtime: TerminalRuntime;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  createdAt: string;
  exitedAt?: string;
  exitCode?: number | null;
}

export type TerminalEvent =
  | { type: "data"; terminalId: string; data: string }
  | { type: "exit"; terminalId: string; exitCode: number | null }
  | { type: "title"; terminalId: string; title: string };

export interface TerminalProvider {
  create(input: TerminalCreateRequest): Promise<TerminalSessionInfo>;
  write(terminalId: string, data: string): Promise<void>;
  resize(terminalId: string, cols: number, rows: number): Promise<void>;
  kill(terminalId: string): Promise<void>;
  list(): Promise<TerminalSessionInfo[]>;
  subscribe(listener: (event: TerminalEvent) => void): () => void;
}
```

UI 层不要直接依赖 `TerminalProvider`，而是依赖更窄的连接接口：

```ts
export interface TerminalConnection {
  create(input: TerminalCreateRequest): Promise<TerminalSessionInfo>;
  write(terminalId: string, data: string): Promise<void>;
  resize(terminalId: string, cols: number, rows: number): Promise<void>;
  kill(terminalId: string): Promise<void>;
  onEvent(listener: (event: TerminalEvent) => void): () => void;
}
```

Electron preload 暴露出来的 `window.desktop.terminal` 就是一个 `TerminalConnection` 实现。未来 WebSocket client 也可以实现同一个接口。

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

如果采用可移植分层，Desktop 里的结构可以理解为：

```text
TerminalTool
  -> TerminalView
  -> DesktopTerminalConnection
  -> preload terminal API
  -> Electron IPC
  -> DesktopTerminalService
  -> LocalTerminalProvider
  -> node-pty
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
  terminalRead: "terminal:read",
  terminalKill: "terminal:kill",
  terminalList: "terminal:list",
  clipboardReadText: "clipboard:read-text",
  clipboardWriteText: "clipboard:write-text",
};

export const IpcEvents = {
  terminalData: "terminal:data",
  terminalExit: "terminal:exit",
  terminalError: "terminal:error",
};
```

共享类型：

```ts
export type DesktopTerminalRuntime = "local" | "sandbox";

export interface TerminalCreateInput {
  projectId: string;
  runtime: DesktopTerminalRuntime;
  cols: number;
  rows: number;
  name?: string;
  shell?: string;
  cwd?: string;
  source?: "user" | "agent";
  sessionId?: string;
}

export interface TerminalRecord {
  id: string;
  name: string;
  projectId: string;
  runtime: DesktopTerminalRuntime;
  source: "user" | "agent";
  sessionId?: string;
  status: "running" | "exited";
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  createdAt: string;
  exitedAt?: string;
  exitCode?: number;
}

export interface TerminalWriteInput {
  terminalId: string;
  data: string;
}

export interface TerminalResizeInput {
  terminalId: string;
  cols: number;
  rows: number;
}

export interface TerminalReadInput {
  terminalId: string;
}

export interface TerminalReadResult {
  terminalId: string;
  data: string;
  sequence: number;
  truncated: boolean;
}

export interface TerminalDataEvent {
  terminalId: string;
  data: string;
  sequence: number;
}

export interface TerminalExitEvent {
  terminalId: string;
  exitCode: number | null;
}
```

preload 暴露：

```ts
window.desktop.terminal = {
  create(input),
  write(input),
  resize(input),
  read(input),
  kill(terminalId),
  list(),
  onEvent(listener),
}

window.desktop.clipboard = {
  readText(),
  writeText(text),
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

终端创建请求统一使用同一个 runtime 字段：

```ts
runtime: "local" | "sandbox";
```

Desktop 不直接判断 sandbox 细节，只把 `runtime` 传给 daemon。daemon/server 再复用现有 sandbox runtime 配置、项目挂载和可用性检查：

```ts
interface TerminalProvider {
  create(input: TerminalCreateInput): Promise<TerminalRecord>;
  write(input: TerminalWriteInput): void;
  resize(input: TerminalResizeInput): void;
  kill(terminalId: string): void;
}
```

本地终端：

```text
LocalTerminalProvider
  -> daemon/server
  -> node-pty
  -> host project cwd
```

沙箱终端 MVP：

```text
LocalTerminalProvider runtime="sandbox"
  -> @openharness/sandbox startSandboxRuntime()
  -> createShellProcess()
  -> pipe-backed interactive shell
```

当前沙箱终端不是完整 PTY。它能支持基础输入、输出、关闭和重启，但复杂行编辑、全屏 TUI 和严格窗口尺寸语义仍以本地 `node-pty` 为准。后续如果 sandbox backend 提供稳定 pseudo-terminal 能力，可以在同一 `TerminalProvider` 接口下替换为真正的 container PTY。

沙箱终端必须复用现有 sandbox runtime 的边界和项目挂载规则，不在 Desktop 里单独复制一套 sandbox 逻辑。

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
  id: string;
  webContentsId: number;
  projectId: string;
  runtime: "local";
  cwd: string;
  shell: string;
  pty: IPty;
  createdAt: Date;
};
```

清理规则：

- 关闭 terminal tab：kill 对应 PTY。
- 关闭右侧 panel：不自动 kill，除非 terminal tab 被关闭。
- 切换 active tab：不 kill，保持命令继续运行。
- 主窗口关闭：断开 Desktop 订阅，不结束 daemon 持有的 PTY。
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

当前 Windows 开发机如果遇到：

```text
error MSB8040: Spectre-mitigated libraries are required for this project.
```

说明 `node-pty` 的 Electron rebuild 需要 VS Spectre 版本的 C++ 运行库。用 `vswhere` 检查时，当前机器缺少：

```text
Microsoft.VisualStudio.Component.VC.Tools.x86.x64.Spectre
```

可通过 Visual Studio Installer 的 Individual components 安装：

```text
MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs
```

安装后重跑：

```bash
pnpm install
```

## 测试场景

当前需要守住的核心场景：

- Desktop typecheck：保证 Electron main/preload/renderer 的 IPC 类型闭合，尤其是 `window.desktop.terminal` 与 `window.desktop.clipboard`。
- terminal-node test + check-types：保证本地 PTY shell 选择和 sandbox runtime 分支类型正确。
- services test：保证项目表 migration、项目重新绑定、项目默认 shell 设置与清空都能落库。
- server test：保证 `/terminals` HTTP route 不吞字段，尤其是 `runtime: "sandbox"`、`cwd`、`source`、`sessionId` 和 `shell` 会原样转发到 `DaemonTerminalService.create()`。
- tools test：保证 Agent terminal tools 和普通工具注册不受 Desktop terminal UI 改动影响。

本轮新增的具体自动化场景：

```text
packages/server/src/http/routes/terminal.test.ts
  -> POST /terminals
  -> body.runtime = "sandbox"
  -> body.cwd/source/sessionId/shell 均传入
  -> 断言 DaemonTerminalService.create 收到完整 TerminalCreateRequest

packages/services/src/session-runtime/__test__/store.test.ts
  -> inspectProject 创建项目
  -> setProjectDefaultShell("pwsh.exe")
  -> getProject/listProjects 可读到 defaultShell
  -> setProjectDefaultShell("")
  -> defaultShell 被清空
```

推荐回归命令：

```bash
pnpm --filter @openharness/desktop run typecheck
pnpm --filter @openharness/terminal-node run test
pnpm --filter @openharness/terminal-node run check-types
pnpm --filter @openharness/terminal run check-types
pnpm --filter @openharness/services run test
pnpm --filter @openharness/server run test
pnpm --filter @openharness/tools run test
```

## 分阶段实现

第一批：本地终端 MVP

- 新增依赖：`@xterm/xterm`、`@xterm/addon-fit`、`@xterm/addon-web-links`、`node-pty`。
- 新增通用 terminal core 类型和接口，优先放 `packages/terminal`；如果第一批想更轻，也要按同样边界放在 Desktop 内部。
- 新增 local runtime provider，封装 `node-pty`，不要让 `node-pty` 类型泄漏到 renderer 和 UI 组件。
- 新增 `terminal-types.ts`。
- 新增 main `terminal-service.ts` 和 `ipc.ts`。
- preload 暴露 `window.desktop.terminal`。
- `UtilityPanel` 把 terminal placeholder 替换为 `TerminalTool`。
- 支持 create、write、data、resize、kill、exit。
- cwd 使用当前项目绑定目录。

当前实现：

- `packages/terminal` 提供可移植协议和事件总线。
- `packages/terminal-node` 提供 `LocalTerminalProvider`、shell 选择和输出节流。
- Desktop main 通过 `apps/desktop/src/main/features/terminal` 暴露 Electron IPC。
- Desktop preload 暴露 `window.desktop.terminal`，形状等价于 `TerminalConnection`。
- Renderer 右侧 panel 使用 `TerminalTool` 和 xterm.js 渲染本地终端。
- `node-pty` 采用懒加载，native 模块不可用时不会阻塞 Desktop 主进程启动，只会让终端创建失败并在终端 UI 中显示错误。

第二批：体验完善

- [x] 支持按项目管理多个终端 tab，并可创建、切换和关闭。
- [x] 支持 clear 和 restart。
- [x] 项目目录不可用时接入重新绑定。
- [x] 终端退出后保留最后输出、exit code 和重启入口。
- [x] 使用有上限的内存输出快照恢复终端视图，不写入数据库。
- [x] 支持 copy selected text 和 paste 菜单，并补齐清空、重启、关闭入口。
- [x] 细化 light/dark 主题，保证 light 主题下 ANSI 白色/亮白色文本不会和背景撞色。
- [x] 保存每个项目的默认 shell，并在新建本地终端时透传给 terminal runtime。

## 在 Agent 应用中的定位

终端不是 Agent 执行每一条命令的默认通道。普通的构建、检查和文件查询仍应走一次性 shell
工具，因为它有明确的输入、退出码和完整结果，便于审计和重试。PTY 终端主要承接需要持续
运行或持续交互的场景，例如开发服务器、watch 任务、REPL、调试器和交互式 CLI。

产品上分成三个入口：

```text
一次性 shell 工具
  -> Agent 执行普通命令，完成后直接返回结构化结果

Agent 持久终端
  -> Agent 创建长期 PTY，会话归属项目或对话
  -> 右侧 panel 可以挂接并由用户接管

用户终端
  -> 用户在右侧 panel 手动创建和操作
  -> Agent 当前不能读取或写入，避免跨所有权操作
```

当前实现已经覆盖“用户终端”和“Agent 持久终端”：PTY 由 daemon 持有，panel 关闭后进程继续
运行；重新打开 panel 时先读取内存快照，再接收实时事件。模型只访问按 session 隔离的
`AgentTerminalHost`，不会直接访问 `node-pty`，也不会复用 renderer 的 xterm 实例。

切换终端时的输出衔接流程：

```text
Renderer 选择 terminalId
  -> Main read(terminalId) 返回 data + sequence
  -> 切换期间的实时事件暂存在 Renderer 队列
  -> xterm 写入快照
  -> 只补写 sequence 大于快照的事件
  -> 恢复实时写入
```

输出快照只存在内存中，每个终端最多保留约 20 万字符。这样能恢复面板，又不会把命令输出、
token 或敏感日志长期写入数据库。

## 当前 Agent 终端实现

PTY 的最终所有者已经从 Electron main 移到 daemon。这样 Agent 工具和桌面右侧 Panel 连接的是同一个进程，桌面窗口只负责转发 HTTP/SSE 与 Electron IPC，不再保存第二套终端状态。

```text
Agent TerminalOpen
  -> ToolContext.terminal -> DaemonTerminalService.createAgentHost(rootSession)
Agent JobList / JobRead / JobWait / JobSend / JobCancel
  -> ToolContext.jobs -> DaemonJobService.createAgentHost(rootSession)
两条路径
  -> LocalTerminalProvider
  -> node-pty

Desktop TerminalTool
  -> preload Electron IPC
  -> DesktopTerminalService
  -> OpenHarnessClient HTTP + SSE
  -> DaemonTerminalService
  -> 同一个 LocalTerminalProvider / PTY
```

运行入口和结果返回：

1. daemon 加载持久会话 Agent 时，根据根会话创建一个终端宿主，并注入 `OpenHarnessAgentOptions.terminal`。
2. `QueryEngine` 创建终端时使用 `ToolContext.terminal`；后续观察和控制通过同一上下文里的 `jobs` 宿主进入 `DaemonJobService`。
3. `TerminalOpen` 创建 `source: "agent"` 的 PTY；记录只保存在 daemon 内存中，不写入会话数据库。
4. 工具结果以稳定的 `kind: "terminal"` JSON 返回模型，同时进入会话 transcript。
5. Desktop 把 `TerminalOpen` 结果渲染成终端卡片；点击卡片后展开右侧 Panel，并通过 terminal id 附着到原 PTY。
6. Panel 先调用 read 获取有上限的输出快照，再根据单调递增的 sequence 接上 SSE 实时输出，避免切换时重复显示。

工具选择规则：

- 普通构建、测试、查询和一次性脚本继续使用 `Bash`，因为它有明确的结束点和完整结果。
- 开发服务器、watch、REPL、调试器以及需要多轮输入的 CLI 使用持久终端。
- `JobSend` 原样写入数据；提交命令发送 `\r`，Ctrl-C 发送 `\u0003`，EOF 发送 `\u0004`。
- `JobRead` 默认最多向模型返回 12000 个字符，完整的 UI 快照仍按终端内存上限保留，避免大量日志占满模型上下文。

所有权和权限：

- Agent 只能读写 `source: "agent"` 且 `sessionId` 与当前 Agent 完全一致的终端。
- 子 Agent 继承同一个宿主对象，但使用自己的 session id，因此不能操作父 Agent 或兄弟 Agent 的终端。
- 用户可在已认证的 Desktop 客户端查看和接管 Agent 终端；Agent 默认不能操作用户手动创建的终端。
- `JobRead`、`JobList` 和 `JobWait` 是只读工具；`TerminalOpen`、`JobSend` 和 `JobCancel` 仍走现有工具权限审批。
- daemon 退出时先关闭 Agent，再回收全部 PTY。关闭 Panel 或 Electron renderer 只断开订阅，不结束 PTY。

当前传输采用 REST 处理命令、SSE 推送输出。这里没有使用 WebSocket，是因为终端输入和 resize 都是短请求，输出才是单向高频流；如果以后需要远程高吞吐或二进制协议，可以只替换 transport，不改 provider、Agent 工具和 xterm 视图。

第三批：沙箱终端 MVP

- 抽象 `TerminalProvider`。
- 复用 `runtime: "sandbox"` 接入现有 sandbox runtime。
- 通过 daemon/server 启动 pipe-backed interactive shell。
- 和开始页的“本地 / 沙箱”运行模式统一。
- 明确 sandbox terminal 的权限提示、网络策略和文件边界。

## 参考资料

- xterm.js: https://github.com/xtermjs/xterm.js
- xterm.js addons: https://xtermjs.org/docs/guides/using-addons/
- node-pty: https://github.com/microsoft/node-pty
- Electron utilityProcess: https://www.electronjs.org/docs/latest/api/utility-process
