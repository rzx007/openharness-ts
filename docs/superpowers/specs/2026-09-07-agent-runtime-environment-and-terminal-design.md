# Agent 运行环境与集成终端设计

> 状态：设计草案，等待审查  
> 日期：2026-09-07  
> 范围：OpenHarness Desktop、Agent Runtime、Docker Sandbox、Terminal

## 1. 背景

OpenHarness Desktop 的设置页计划提供两项职责不同、但相互关联的配置：

- **智能体运行环境**：本机或 Docker 沙箱。
- **集成终端 Shell**：用户打开集成终端时使用的 Shell，例如 PowerShell 或容器内 Bash。

运行环境决定新终端在哪里启动，Shell 配置再决定使用该环境中的哪个命令解释器。本文明确它们分别控制什么、Docker 模式下文件和命令如何运行，以及当前实现与目标行为之间的差距。

## 2. 核心结论

1. “智能体运行环境”控制的是 **Agent 发起的工作负载在哪里执行**，不是把整个 Agent 控制程序搬进 Docker。
2. Agent 控制程序、模型调用、权限审批、任务状态和 Desktop/daemon 仍在宿主机运行。
3. 选择 Docker 后，Agent 的命令、文件操作、后台任务和交互终端都应进入同一个 Docker 沙箱。
4. 用户集成终端默认跟随 Agent 运行环境，让用户和 Agent 使用同一套工具、路径和依赖；用户仍可显式新建宿主终端。
5. “集成终端 Shell”只能选择当前终端目标环境中真实可用的 Shell，不能把宿主 PowerShell 直接套用到 Linux 容器。
6. Agent Terminal 必须始终跟随 Agent 运行环境，不能通过终端绕开 Docker 沙箱。
7. Windows 上的项目目录挂载到 Docker 的 `/workspace`。Docker 内的 Agent 命令统一使用 Linux 路径和 `/bin/sh` 语法。
8. Docker 不可用时必须明确失败，不能静默回退到宿主机。

## 3. 术语

### 3.1 宿主环境

运行 OpenHarness Desktop、daemon 和 Docker Desktop 的操作系统。例如 Windows。

### 3.2 Agent 控制程序

负责模型调用、工具调度、权限检查、审批、任务状态和结果回传的 OpenHarness 进程。Docker 模式下它仍运行在宿主机。

### 3.3 Agent 工作负载

Agent 为完成任务而触发的实际操作，包括：

- Shell 命令；
- 后台进程；
- 文件读取、写入、编辑和搜索；
- Hook 和 Cron 命令；
- LSP、ripgrep 和 MCP stdio 子进程；
- Agent 通过 `TerminalOpen` 创建的交互终端。

### 3.4 用户集成终端

用户在 Desktop 终端面板中打开并手动输入命令的终端。它与 Agent 创建的终端不是同一个会话，但默认使用相同的运行环境，方便用户复现 Agent 的命令和问题。

### 3.5 Agent Terminal

Agent 通过以下工具组合创建和控制的交互终端：

```text
TerminalOpen → JobSend → JobRead / JobWait / JobCancel
```

它用于 REPL、交互式 CLI，以及需要保留会话状态的命令。

## 4. 配置边界

### 4.1 智能体运行环境

建议取值：

```text
local   本机
docker  Docker 沙箱
```

它决定所有 Agent 工作负载的执行边界。

### 4.2 集成终端 Shell

可选 Shell 由终端目标环境决定：

```text
本机：PowerShell | Command Prompt | Git Bash
Docker：/bin/sh | /bin/bash（镜像中存在时）
```

该配置只决定用户集成终端在目标环境中启动哪个 Shell，不直接控制 Agent 的普通 Shell 工具。Windows 的 `powershell.exe` 通常不存在于 Linux 容器中，因此 Docker 模式不能继续沿用宿主 PowerShell 配置。

用户集成终端默认跟随 Agent 运行环境。终端“新建”菜单提供一次性的“在本机打开”入口，供用户管理 Docker、Git 或宿主文件；该入口不改变 Agent 的运行环境，也不改变后续终端的默认行为。

本机和 Docker 的 Shell 偏好应分别保存。例如用户从“本机 + PowerShell”切到“Docker + Bash”，再切回本机时，仍恢复 PowerShell，不能把 Bash 当作本机配置。

### 4.3 推荐组合

| Agent 运行环境 | 默认用户集成终端 | Agent 命令 | Agent Terminal |
|---|---|---|---|
| 本机 | 用户选择的本机 Shell | 宿主 Shell | 本机默认 Shell，或 Agent 显式指定的本机 Shell |
| Docker | 用户选择的容器 Shell | 容器 `/bin/sh` | 容器 Shell |

默认用户集成终端与 Agent 使用同一个环境，但它们仍是相互独立的会话。需要宿主终端时，用户通过“在本机打开”显式创建，而不是让全局默认长期处于混合环境。

这里统一的是 **环境、工作目录和路径风格**，不是强制所有入口使用同一个 Shell 名称。例如 Docker 中 Agent 普通命令固定通过 `/bin/sh -c` 执行，而用户集成终端可以选择镜像中真实存在的 `/bin/bash`。

切换运行环境只影响后续创建的 Agent Runtime 和终端，不迁移已经运行的进程或终端会话。存在活跃任务时应阻止切换并说明原因；没有活跃任务时关闭旧 Runtime，再按新环境创建。

## 5. Docker 模式的运行流程

```text
用户发送请求
    ↓
宿主机上的 Agent 控制程序
    ├─ 调用模型
    ├─ 判断权限和审批
    ├─ 维护会话与任务状态
    └─ 调度 Agent 工具
            ↓
      Docker 沙箱路由
            ↓
      项目容器 /workspace
            ├─ /bin/sh 命令
            ├─ 文件读写和搜索
            ├─ 后台进程
            ├─ Agent Terminal
            └─ 默认用户集成终端
            ↓
      输出返回宿主 Agent
            ↓
      Agent 向用户回答
```

### 5.1 容器生命周期

启动 Agent Runtime 时，根据项目目录和会话范围准备 Docker 容器。项目级复用模式可保留容器供同一项目的后续会话使用；临时模式在 Runtime 结束时停止并删除容器。

### 5.2 工作区挂载

Windows 项目：

```text
D:\code\personal-project\OpenHarness-ts
```

容器内对应：

```text
/workspace
```

两边指向同一批项目文件，不是复制两份。容器默认不应看到 Windows 用户目录、桌面或工作区之外的其他宿主路径。

### 5.3 命令执行

Agent 发起：

```bash
pnpm test
```

Docker 模式下等价于：

```text
docker exec -w /workspace <container> /bin/sh -c "pnpm test"
```

Shell 工具接收整段命令文本，不能可靠地把 PowerShell 命令自动翻译成 POSIX 命令。因此必须在生成命令之前把真实执行环境告诉 Agent。

### 5.4 文件工具

`Read`、`Write`、`Edit`、`Glob` 和 `Grep` 先由宿主机完成权限与路径判断，再把工作区路径转换到容器路径，实际文件操作在容器中进行：

```text
D:\code\project\src\index.ts
        ↓
/workspace/src/index.ts
```

权限批准和 diff 编排仍留在宿主机，但批准不等于自动增加 Docker 挂载。

## 6. Agent 如何知道路径和 Shell 风格

Agent 依赖系统提示词中的环境事实决定生成 Windows 命令还是 Linux 命令。工具层只负责执行和已知路径映射，不负责翻译任意 Shell 文本。

### 6.1 本机模式应注入

```text
# Execution Environment
- Runtime: local
- OS: Windows
- Shell: PowerShell
- Working directory: D:\code\project
- Path style: Windows
- Home directory: C:\Users\<user>
```

### 6.2 Docker 模式应注入

```text
# Execution Environment
- Runtime: Docker sandbox
- Host OS: Windows
- Execution OS: Linux
- Shell: /bin/sh
- Working directory: /workspace
- Path style: POSIX
- Host workspace is mounted read-write at /workspace
- Host paths outside the mounted workspace are unavailable
```

“宿主环境”和“执行环境”必须分开描述。Docker 模式下只告诉 Agent“宿主是 Windows”，却不告诉它命令实际在 Linux 中运行，会导致 Agent 生成错误的 PowerShell 命令或 `D:\...` 路径。

## 7. 自然语言文件请求

Docker 模式下，未指定明确路径的文件请求默认以 `/workspace` 为范围。

例如用户说：

```text
看看我的桌面有哪些文档
```

Docker 容器没有 Windows 桌面概念。按当前产品期望，Agent 应：

1. 不访问 `C:\Users\<user>\Desktop`；
2. 在 `/workspace` 中查找文档；
3. 在回复中说明查找范围是当前 Docker 沙箱工作区，而不是宿主机桌面。

示例回复：

```text
当前任务运行在 Docker 沙箱中。我已在沙箱工作区 /workspace 中查找文档；宿主机桌面未挂载，因此没有访问。
```

如果用户明确要求访问真实 Windows 桌面，需要同时满足：

- 用户明确授权；
- OpenHarness 建立范围明确的显式挂载；
- 根据用途选择只读或读写；
- Agent 的环境信息中公布对应的容器路径。

仅有一次权限批准不能让容器凭空访问未挂载的目录。

## 8. 失败策略

用户选择 Docker 沙箱意味着用户依赖这个隔离边界，因此应采用 fail-closed 策略：Docker 不可用时停止执行并明确报错。

```text
Docker 可用     → 在容器内执行
Docker 不可用   → 报错并提示检查 Docker
不允许          → 静默回退到宿主机
```

这条规则必须覆盖 Shell、后台进程、文件工具、Agent Terminal、Hook、Cron、LSP 和 MCP stdio，不能只覆盖普通 `Bash`。

## 9. 当前实现

当前已经具备：

- Docker Runtime 启动与项目容器复用；
- Windows 工作区挂载到 `/workspace`；
- `Bash`、后台进程、Hook、Cron、LSP 和 MCP stdio 的统一沙箱进程入口；
- Docker active 时，文件工具在容器内实际读写与搜索；
- 容器内命令使用 `/bin/sh -c`；
- Terminal Provider 已实现 `runtime: "sandbox"` 分支。

当前仍有以下差距：

1. 设置页“运行环境”仍是静态占位，没有保存或应用配置。
2. Desktop 用户集成终端固定传入 `runtime: "local"`。
3. Agent Terminal 同样固定传入 `runtime: "local"`，因此可能绕过 Agent 的 Docker 执行边界。
4. Agent 系统提示词目前主要根据宿主机生成环境信息。Windows + Docker 模式下，模型可能收到 Windows、PowerShell 和宿主绝对路径，但命令实际由容器 `/bin/sh` 执行。
5. Docker 设置允许不可用时降级到宿主机；作为桌面“运行环境”选择使用时，需要强制 fail-closed。

## 10. 目标行为矩阵

| 操作 | 本机环境 | Docker 沙箱环境 |
|---|---|---|
| Agent 短命令 | 宿主 Shell | 容器 `/bin/sh` |
| Agent 后台命令 | 宿主进程 | 容器进程 |
| Agent TerminalOpen | 本机终端 | 容器终端 |
| Read/Write/Edit | 宿主文件系统，受权限限制 | `/workspace`，受权限和挂载限制 |
| Glob/Grep | 宿主工作区 | 容器 `/workspace` |
| Hook/Cron | 宿主进程 | 容器进程 |
| LSP/MCP stdio | 宿主进程 | 容器进程 |
| 默认用户集成终端 | 用户选择的本机 Shell | 用户选择的容器 Shell，工作目录为 `/workspace` |
| 显式宿主终端 | 用户选择的本机 Shell | 用户选择的本机 Shell，不改变 Agent 环境 |
| Git worktree 管理 | 宿主机 | 宿主机 |
| Desktop/daemon | 宿主机 | 宿主机 |

## 11. UI 文案建议

为了减少歧义，可以把设置项写成：

```text
智能体运行环境
选择 Agent 的命令、文件工具和后台任务在本机还是 Docker 沙箱中运行。

集成终端 Shell
选择新终端在当前 Agent 环境中使用的 Shell。Docker 模式只显示镜像内可用的 Shell。
```

Docker 选项可补充说明：

```text
项目目录将挂载到容器的 /workspace。Agent 和默认集成终端都在容器中运行，宿主机其他目录默认不可见。
```

终端“新建”菜单提供：

```text
新建终端
├─ 在当前 Agent 环境中打开（默认）
└─ 在本机打开
```

## 12. 验收标准

### 12.1 环境信息

- 本机模式下，Agent 看见宿主 OS、Shell 和宿主工作目录。
- Docker 模式下，Agent 看见 Linux、`/bin/sh` 和 `/workspace`。
- Docker 模式同时标明宿主 OS，但不能让宿主信息覆盖有效执行环境。

### 12.2 执行边界

- Docker 模式下，`Bash`、后台命令和 Agent Terminal 均能通过 `pwd` 得到 `/workspace`。
- Docker 模式下，通过 Agent Terminal 创建文件后，文件出现在挂载的宿主项目目录中。
- Docker 模式下，Agent 无法通过任何命令或文件工具访问未挂载的 Windows 桌面。
- Docker 不可用时，Agent 工具明确失败，宿主机上没有对应命令被启动。

### 12.3 终端一致性与显式例外

- Docker Agent 环境下，新建的默认用户集成终端进入同一个容器，并以 `/workspace` 为工作目录。
- Docker Agent 环境下，用户集成终端只能选择镜像中可用的 `/bin/sh` 或 `/bin/bash`。
- 修改“集成终端 Shell”不会改变 Agent 普通命令固定使用的 `/bin/sh -c`。
- 本机与 Docker 的 Shell 偏好分别保存，切换回来时恢复各自上次的选择。
- 用户可以显式新建本机 PowerShell，但该终端清楚标记为“本机”，且不改变 Agent 环境。
- Agent TerminalOpen 不提供宿主例外，Docker 模式下必须始终进入当前 Agent 容器。
- 有活跃任务时不能切换 Agent 环境；切换不会迁移已经打开的终端会话。

### 12.4 自然语言路径

- Docker 模式下，“查找文档”等未指定路径的请求以 `/workspace` 为默认范围。
- Docker 模式下，“我的桌面”等宿主语义不会触发对真实 Windows 桌面的访问。
- 回复中明确说明实际查找的是沙箱工作区。

## 13. 不在本设计范围内

- 自动挂载 Windows 桌面、下载目录或整个用户目录；
- 在 Docker 镜像内安装 PowerShell；
- 自动把显式创建的本机终端切换回 Docker；
- 把 Desktop、daemon 或完整 Agent 控制程序迁入 Docker；
- 在 Shell 工具层翻译 PowerShell 与 POSIX 命令。
