# 集成终端 Shell 设计

## 背景

设置页「常规 → 集成终端 Shell」现在是写死的「PowerShell」按钮，点了不会保存。

用户新开本地集成终端时，渲染进程只在项目填过 `defaultShell` 时才把路径传给 `terminal.create`。没填就让 daemon（桌面后面的本地服务）按系统自动挑：Windows 优先 PowerShell 7，再 Windows PowerShell，再 cmd；macOS / Linux 走 `$SHELL` 或 `/bin/zsh`、`/bin/bash`、`/bin/sh`。

侧边栏项目菜单还能手填「设置默认 Shell」，只影响那一个项目。设置页和侧边栏没有共用默认值。

设置页是 `/settings` 路由，对话页是 `/_main` 路由，同一窗口里不同页面，不会同时挂着。

## 目标

- 只在设置页改「新开本地集成终端用哪个 Shell」。一改，所有项目新开的本地终端都用它。
- 下拉第一项永远是「系统默认」；后面只列本机已装的 Shell。没装的不出现。
- 侧边栏不再提供按项目改默认 Shell 的入口。项目上旧的手填值不再参与创建。
- Windows / macOS / Linux 都检测，不写死成 Windows 专用。

## 非目标

- 不改「运行环境」。
- 不改 Agent 自己开的终端、对话里的 Bash 工具、沙箱终端。
- 不让用户手填自定义路径。
- 不列 fish、WSL、Windows Terminal。
- 不删项目表里的 `default_shell`，不做数据迁移。
- 不把这项同步到对话服务、其它设备或多窗口。
- 不要求已经开着的终端马上换 Shell。
- 不改 daemon 里 `resolveDefaultShell` 的自动挑选顺序。

## 数据存哪

默认值是本机桌面偏好，和「通知」「默认文件打开目标」同一份文件：

- 文件：`userData/desktop-preferences.json`
- 字段：`defaultTerminalShellId`，字符串或省略。文件里没有该字段时不要写成 `null`
- 选「系统默认」、没这项设置、空串、只含空白、值为 `system`、文件里不是字符串、文件损坏：都当成「系统默认」，文件里省略该字段。非空字符串都算合法 id，不做「是不是已知 Shell」校验
- 选了具体 Shell：写下它的 id（见下表）。保存的是 id，不是某次扫到的完整路径

`DesktopPreferences` 必须同时读回 `notificationMode`、`defaultOpenerId`、`defaultTerminalShellId`。任何一次 `patchDesktopPreferences` 都不能丢掉另外两个字段。

改通知或打开目标不得抹掉 Shell；改 Shell 也不得抹掉另外两项。从具体 Shell 改回「系统默认」时，必须从文件里去掉 `defaultTerminalShellId`，不能留下旧 id。实现上 `patch` 不能只做 `{ ...旧对象, ...补丁 }` 就完事：补丁里要把该字段清掉时，写盘结果里不能再出现它。

`DesktopSettingsSnapshot` 增加 `defaultTerminalShellId: string | null`（系统默认时为 `null`）。  
`buildDesktopSettingsSnapshot` 的本机偏好参数要能接收 `defaultTerminalShellId`。工作风格仍来自 daemon。

新增 IPC：`settings:update-default-terminal-shell`。  
入参类型 `UpdateDesktopDefaultTerminalShellInput`：`{ defaultTerminalShellId: string | null }`。  
主进程先 `trim`（`null` 保持 `null`）。`null`、空串、`system` 都表示「系统默认」，写盘时省略字段。其它非空字符串原样写入，写盘时不检查「现在还装不装得上」。

**写成功的标准是本机文件写成功。** `patchDesktopPreferences` 写盘失败必须让这次 IPC 抛错，不能只 `console.warn` 还返回新对象。daemon 只用来拼 snapshot 里的工作风格；它挂了不能把已经写成功的本机默认说成失败。此时仍返回 snapshot：本机三项用文件里的值，`workStyle` 回落 `practical`。

渲染进程通过 `window.desktop.settings.updateDefaultTerminalShell` 保存。

读列表用新 IPC：`terminal:list-shells`。返回本机已检测到的 `{ id, label }[]`，**不含**「系统默认」，**不含**可执行文件路径。设置页自己把「系统默认」插在第一项，对应 snapshot 的 `null`。

## 谁读、谁写

| 入口 | 读默认 | 写默认 |
|---|---|---|
| 设置页「集成终端 Shell」 | 是 | 是 |
| 桌面主进程 `terminal.create`（本地且调用方没带 `shell`） | 是，当场解析成路径或省略 | 否 |
| 渲染进程 `terminal-tool` 创建 / 重启 | 否 | 否 |
| 侧边栏 | 否 | 否 |

不把窗口内 `CustomEvent` 当主路径。也不要求多窗口一起变。

设置页读 `defaultTerminalShellId` **不能绑死** daemon。`snapshot()` 先读本机偏好，daemon 只补工作风格；daemon 失败时本机字段照常返回。

## 列表从哪来

检测放在桌面主进程，按当前 `process.platform` 扫描，只返回存在的项：

| 系统 | id | 显示名 | 怎么算「已装」 |
|---|---|---|---|
| Windows | `pwsh` | PowerShell 7 | PATH 上有 `pwsh.exe` |
| Windows | `powershell` | Windows PowerShell | 常见安装路径或 PATH 上有 `powershell.exe` |
| Windows | `cmd` | 命令提示符 | `ComSpec` / `COMSPEC` 指向的文件存在，或 PATH 上有 `cmd.exe` |
| Windows | `git-bash` | Git Bash | 和右上角打开方式同一套 Git 路径：`Git\\git-bash.exe`、`Git\\bin\\bash.exe`（Program Files / Program Files (x86)） |
| macOS | `zsh` | zsh | `/bin/zsh` 存在 |
| macOS | `bash` | bash | `/bin/bash` 存在 |
| Linux | `bash` | bash | `/bin/bash` 存在 |
| Linux | `sh` | sh | `/bin/sh` 存在 |

同一 id 三端含义固定。保存的是当前系统那个 id；换系统后对不上就当「系统默认」，不会拿 Windows 的 `powershell` 去 macOS 上起进程。

不把 `$SHELL` 额外加成一项。系统默认的自动挑选仍由 daemon 现有 `resolveDefaultShell` 负责。

## 新开终端怎么用这个值

生效范围：桌面里用户新开的**本地**集成终端。沙箱、Agent 终端、Bash 工具不读这项。

渲染进程 `terminal-tool` 创建时**不再**传 `project.defaultShell`。重启终端会先关掉旧 PTY 再走同一条 `create`，因此重启也会换成当前全局设置。已经开着、没重启的终端不改。

桌面主进程在 `terminal.create` 里补 `shell`：

1. 调用方已经带了非空 `shell` → 照用不改
2. `runtime` 不是 `local` → 不补
3. 偏好里没有 `defaultTerminalShellId`，或规范化后是系统默认 → 不传 `shell`，daemon 走 `resolveDefaultShell`
4. 有具体 id → 当场再扫一遍本机；命中则把可执行文件路径填进 `shell`
5. 以前存过的 id 此刻扫不到（例如卸了 Git）→ 当成系统默认，不拦创建

解析函数 `resolvePreferredTerminalShell` 输入是「偏好 id + 当前检测结果」，输出是 `string | undefined`（`undefined` 表示不要往 create 里塞 `shell`）。设置页不调用这条解析来起进程；它只用来创建终端。

设置页 Select 的选中项：

1. `defaultTerminalShellId` 能在检测列表里找到 → 用这一项
2. 否则用「系统默认」（`null` / 哨兵 `system` 仅存在于 UI，不写进偏好文件）

本机偏好还没读回来时，不要先闪「PowerShell」再跳到真实默认。等偏好读完再定选中项；列表可以先出来。

## 设置页 UI

把写死的 `SettingSelect`（`TerminalSquare` + 「PowerShell」）换成真正的下拉，交互对齐「工作风格 / 通知 / 默认文件打开目标」：

- 打开页时读 snapshot（本机字段不依赖 daemon）+ `list-shells`
- 第一项「系统默认」；后面是检测列表
- 选一项就保存。选「系统默认」走 `defaultTerminalShellId: null`
- 加载中或保存中禁用
- 失败则回到改之前的选项，控件右侧用同一套红色说明（`settings-error-message`）
- 检测失败或列表为空：仍能选「系统默认」，不要整页报死，也不假装还能选 PowerShell
- 不给每个 Shell 配系统图标；触发按钮继续用现有终端图标即可

## 侧边栏

从项目菜单拿掉「设置默认 Shell」和对应对话框、相关本地 state 和 `onSetDefaultShell`。

`setProjectDefaultShell` 这条 IPC、store 方法和项目表字段先留着，界面不再调用。创建终端时也不再读 `project.defaultShell`。不删库、不迁移旧值。

## 失败和空状态

- 保存偏好失败（写盘抛错）：设置页回滚并提示。对话页当时不在树上；下次新开终端仍读盘上的旧值。
- 读偏好失败或值非法：当成系统默认，设置页选中「系统默认」，不因此整页报错。
- 本机列表扫描失败：下拉仍能选「系统默认」。
- daemon 挂了：仍能读、写本机默认；新开终端是否成功取决于现有 daemon 是否可用，不把「偏好写成功」说成失败。
- 创建时 id 已失效：静默回落系统默认。
- PTY 拉不起来：仍用终端面板现有的错误条。

## 测试

先写测试再改实现。

1. **本机偏好**：能读写合法 `defaultTerminalShellId`；`null` / `system` / 空 / 只含空白 / 坏文件都回落到系统默认（文件省略字段）。改 Shell 不影响 `notificationMode` 和 `defaultOpenerId`；改另外两项不影响已保存的 Shell。从具体 id 改回系统默认后，文件里不能再出现该字段。写盘失败要抛错。
2. **检测**：Windows / macOS / Linux 只返回存在的项；「系统默认」不进检测列表；不返回路径给渲染进程合约。
3. **创建补全**：本地 + 已选 id → 带上对应路径；本地 + 系统默认 / 未知 id → 不带 `shell`；调用方已带 `shell` → 不覆盖；非本地 → 不补。
4. **设置页**：能保存具体 id 和回到系统默认；Select 的 value 在 id 失效时是系统默认；保存失败回退。
5. **创建终端**：`terminal-tool` 不再因 `project.defaultShell` 传 `shell`。
6. **侧边栏**：没有「设置默认 Shell」菜单项和对话框。
7. **snapshot 形状**：更新这些会立刻红的精确比对 / 字面量（与默认打开目标同一批测试文件），旧偏好没有该字段时 snapshot 为 `null`。

验证时跑桌面相关测试、改动文件的 lint 和类型检查。

## 关键改动位置

- `apps/desktop/src/shared/settings-types.ts` — snapshot 增加字段；`UpdateDesktopDefaultTerminalShellInput`；规范化函数；`buildDesktopSettingsSnapshot` 带上新字段
- `apps/desktop/src/main/features/settings/desktop-preferences.ts` — 三字段一起读回；支持清掉 `defaultTerminalShellId`；写失败抛错
- `apps/desktop/src/main/features/settings/settings-service.ts` 与 IPC / preload / 合约 / `ipc-channels.ts` — 新增更新接口；snapshot 本机字段不依赖 daemon
- `apps/desktop/src/main/features/terminal/detect-shells.ts` — 检测列表与 `resolvePreferredTerminalShell`；IPC `terminal:list-shells`
- `apps/desktop/src/main/features/terminal/terminal-service.ts` — 本地 create 且未带 `shell` 时按偏好补路径
- `apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx` — 换成真实下拉
- `apps/desktop/src/renderer/src/components/desktop/tools/terminal/terminal-tool.tsx` — 去掉 `project.defaultShell`
- `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar.tsx` — 拿掉按项目设置 Shell 的菜单和对话框
