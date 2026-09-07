# Agent 运行环境与集成终端设计

> 状态：第二期统一终端体验已实现并通过本机真实 Docker PTY 验证；第三期未开始
>
> 日期：2026-09-07
>
> 范围：OpenHarness Desktop、Agent Runtime、Docker Sandbox、Terminal、文件工具与 Skill

## 1. 目标

OpenHarness Desktop 提供两种 Agent 运行环境：

- 本机；
- Docker 沙箱。

Agent 控制程序继续在宿主机运行。Agent 发起的命令、脚本、文件操作、后台进程和交互终端通过统一执行环境运行。

Docker 模式只把明确允许的宿主目录挂载进容器。当前阶段允许读写两个目录：

```text
当前工作区        → /workspace
用户级 Skill 目录 → /opt/openharness/skills
```

容器对这两个目录的修改会直接影响宿主文件。其他宿主目录在当前版本中不提供给 Agent。

## 2. 核心原则

1. Agent 核心不处理 Docker 启动、挂载、路径转换和进程创建细节。
2. Shell、文件工具、Agent Terminal 和默认用户集成终端使用同一个有效执行环境。
3. 环境启动并通过探测后，才生成 Agent 可见的环境信息。
4. Docker 模式下，Agent 和文件工具统一使用容器路径。
5. 安全边界由执行环境和 Docker 强制实现，不能只依赖提示词。
6. Docker 不可用时明确失败，不允许静默回退到宿主执行。
7. Agent Terminal 必须跟随 Agent 环境，不能作为绕过沙箱的通道。
8. 用户集成终端默认跟随 Agent 环境，同时允许用户显式打开宿主终端。
9. 项目外会话仍有独立受管工作区，不存在“无 cwd 的 Agent Runtime”。
10. 用户级 Skill 目录当前采用读写挂载；这是明确接受的持久化风险，后续再收紧。
11. 每个工作区同一时间只保留最新配置对应的容器，不支持多版本容器并存。
12. 功能分期交付；尚未接入执行环境的模型工具在 Docker 模式下先禁用。

## 3. 术语与边界

### 3.1 宿主环境

运行 OpenHarness Desktop、daemon 和 Docker Desktop 的系统，例如 Windows。

### 3.2 Agent 控制程序

负责模型调用、工具调度、权限审批、任务状态、diff 展示和结果回传的宿主进程。

### 3.3 Agent 工作负载

包括：

- 短命令和 argv 进程；
- 后台进程；
- Read、Write、Edit、Glob 和 Grep；
- Hook 和 Cron 命令；
- LSP、ripgrep 和 MCP stdio 子进程；
- Agent 通过 `TerminalOpen` 创建的交互终端；
- 非隔离子 Agent 及隔离 worktree 子 Agent 发起的上述操作。

### 3.4 用户集成终端

用户在 Desktop 终端面板中创建并手动操作的终端。它和 Agent Terminal 是不同会话，但默认附着到同一个执行环境。

### 3.5 Agent Terminal

Agent 通过下面的工具组合创建和操作的交互终端：

```text
TerminalOpen → JobSend → JobRead / JobWait / JobCancel
```

### 3.6 有效执行环境

有效执行环境是工具与具体后端之间唯一的运行边界：

```text
ExecutionEnvironment
├─ start / inspect / close
├─ execShell / execProcess
├─ openTerminal
├─ fileOperations
├─ resolvePath / presentPath
├─ environmentInfo
└─ acquireLease / releaseLease
```

`LocalEnvironment` 和 `DockerEnvironment` 实现同一契约。Agent 核心和业务工具不能散落 `if local`、`if docker`，也不能直接拼接 `docker exec`。未来增加 WSL、SSH 或远程容器时，应增加执行环境实现。

执行环境契约不直接包含 Git、Skill Registry、会话存储等宿主控制面职责。它只提供运行工作负载所需的进程、文件、路径、终端和环境事实能力。

### 3.7 包职责与依赖方向

新增 `@openharness/environment` 作为纯契约包，不依赖 Node、Docker、Tools、Terminal 或 Agent Runtime：

| 包 | 职责 |
|---|---|
| `@openharness/environment` | 环境接口、环境信息、WorkspaceBinding、路径结果、lease 类型 |
| `@openharness/core` | ToolContext 和 Runtime 核心类型引用环境契约，不实现环境后端 |
| `@openharness/sandbox` | Local/Docker 的进程、文件、路径、挂载和低层 Docker 执行实现 |
| `@openharness/terminal-node` | 本机 PTY、Docker PTY、终端会话输入输出和信号 |
| `@openharness/server` | Environment Manager、容器所有权、设置应用、恢复和服务端校验 |
| `@openharness/tools` | 把 Bash、文件和其他工具适配到环境能力，不管理环境生命周期 |
| `@openharness/prompts` | 将 EffectiveEnvironmentInfo 格式化给模型 |
| `@openharness/agent-runtime` | 获取环境能力、组装 Agent、注入提示词、释放 runtime lease |

依赖方向固定为：

```text
environment ← sandbox
environment ← terminal-node
environment ← tools
environment ← core
environment ← permissions

server → environment + sandbox + terminal-node
agent-runtime → environment
prompts → environment
```

`sandbox` 不依赖 `tools` 或 `terminal-node`，避免形成循环依赖。Docker PTY 由 `terminal-node` 使用 `sandbox` 暴露的低层 Docker exec 描述实现；Environment Manager 在 server 中组装最终能力。

### 3.8 工具执行域

每个模型可调用工具必须注册执行域：

```ts
type ToolExecutionDomain = "environment" | "control_plane";
```

缺少声明时默认按 `environment` 处理。Docker 模式下，无法使用环境能力的 `environment` 工具不注册给模型。

| 工具类型 | 执行域 | Docker 规则 |
|---|---|---|
| Bash、后台 Shell、文件工具、LSP、MCP stdio | environment | 必须进入当前 Docker 环境 |
| MCP HTTP/SSE | control_plane | 受当前会话网络和权限策略控制，不获得宿主文件能力 |
| Agent Terminal | environment | 第二期接入 Docker PTY；第一期禁用 |
| Native Plugin Tool | environment | 第一、二期禁用；后续接入环境后再启用 |
| `ImageToText(image_path)` | environment | 文件必须通过环境文件能力读取 |
| `ImageToText(assetId)`、附件读取 | control_plane | 只允许当前会话已授权的不可变附件 |
| ImageGeneration | control_plane | 不接受任意宿主文件路径；结果进入附件服务 |
| Skill、ListSkills | control_plane | 宿主加载元数据，路径通过当前环境呈现 |
| WebSearch、WebFetch、ImageToText URL | control_plane | 受权限与有效网络策略控制，不获得宿主文件能力 |

Runtime 创建时枚举全部模型可见工具并验证执行域，避免靠手写 fail-closed 清单遗漏新工具。

## 4. 配置模型

### 4.1 复用现有 Sandbox 配置

Desktop 不新增第二个 Agent 环境真值。设置页“智能体运行环境”写入现有字段：

```text
本机：
sandbox.enabled = false

Docker：
sandbox.enabled = true
sandbox.backend = "docker"
sandbox.failIfUnavailable = true
```

Desktop 当前只展示“本机”和“Docker”。SRT 配置继续服务 CLI 等高级入口，不在本次 Desktop 设置改造范围内。

### 4.2 Terminal 配置

新增用户设置：

```ts
terminal: {
  localShell?: string;
  dockerShell?: "/bin/sh" | "/bin/bash";
}
```

本机和 Docker 的 Shell 偏好分别保存。Docker Shell 必须在目标容器中探测存在后才能使用。

`ProjectRecord.defaultShell` 是当前终端功能的项目级本机 Shell 覆盖，不改写为 Docker Shell。

Shell 解析顺序：

```text
本机用户终端：请求显式 shell
              > ProjectRecord.defaultShell
              > settings.terminal.localShell
              > 操作系统默认 Shell

Docker 用户终端：请求显式 shell
                > settings.terminal.dockerShell
                > /bin/sh

Docker Agent Terminal：Agent 显式请求的 /bin/sh 或 /bin/bash
                     > /bin/sh
```

Agent 在 Docker 中不能请求宿主可执行文件。本阶段 Docker 交互终端只允许 `/bin/sh` 和 `/bin/bash`，不提供自定义 Shell 允许列表。

### 4.3 单一最新配置

不保存可恢复的 Session 环境版本，也不允许同一 workspace owner 同时运行多个配置版本。会话每次创建或恢复 Runtime 时，都使用当时解析出的最新有效配置。

容器 label 保存 `executionConfigHash` 只用于判断现有容器是否过期，不作为历史配置快照。配置变化后，旧容器必须在没有使用者时被最新容器替换。

因此：

- 旧会话恢复时使用最新配置；
- 不为旧会话重建旧镜像、旧网络或旧挂载；
- 不需要在 Session metadata 持久化环境配置或 hash；
- 同一 owner 的容器名称不包含 config hash；
- 配置变化需要重启应用/daemon，第一期不支持运行中热切换。

### 4.4 解析入口与优先级

环境解析使用唯一入口：

```ts
resolveExecutionEnvironmentConfig({
  surface: "desktop_managed" | "cli_advanced",
  cwd,
  overrides,
})
```

优先级由低到高为：

1. 默认值；
2. 用户级 `settings.json`；
3. 项目级 `settings.json`，项目外会话跳过；
4. `OPENHARNESS_SANDBOX_*` 环境变量；
5. CLI 显式覆盖。

本阶段不提供 Session 级环境覆盖。

`desktop_managed` 只接受 local 或 docker，强制 fail-closed，并拒绝 SRT、`extraMounts`、Docker Socket 和 privileged 配置。`cli_advanced` 保留现有 SRT 与 extraMounts 能力，不享受本文的 Desktop 受管隔离承诺。

配置为 `sandbox.enabled=true, backend="srt"` 时，Desktop 显示“高级 CLI 沙箱配置不受 Desktop 支持”，不创建 Agent Runtime。用户选择“本机”或“Docker”后，Desktop 才写入对应的受管配置；不能把 SRT 静默解释为本机。

### 4.5 Settings Schema

Settings 文件不保存 `_formatVersion`。用户级和项目级配置直接按当前字段结构校验；出现 `_formatVersion`、`sandbox.runtime` 或其他废弃/未知字段时，返回带文件路径的 `invalid_settings_field`。

不做自动迁移、别名转换或旧字段回退。用户需要自行删除不符合当前结构的配置并由 OHS 重新生成，或按照错误提示手动修改。Session metadata 不保存环境配置。

### 4.6 Terminal 协议兼容

Terminal 协议现有 `runtime: "local" | "sandbox"` 保持兼容：

- `local` 表示显式宿主终端；
- `sandbox` 表示附着到所属会话的有效 Docker 环境。

Desktop 内部的环境类型使用 `local | docker`。协议层只在边界处完成 `docker → sandbox` 映射，不能把二者作为两套独立配置。

## 5. 环境创建与配置生效

### 5.1 新会话

```text
按 surface 解析最新配置
    ↓
校验挂载与 Docker 配置
    ↓
准备候选环境
    ↓
执行健康探测
    ↓
生成 EffectiveEnvironmentInfo
    ↓
发布环境句柄并创建 Agent
```

任一步失败都关闭候选环境，不创建 Agent，不执行任何宿主回退命令。

### 5.2 修改全局默认环境

第一期采用“保存后重启生效”，不实现运行中热切换：

1. 归一化候选设置；
2. 以 `desktop_managed` 规则校验 Docker CLI、daemon、镜像、挂载和保留路径；
3. 执行不会创建长期容器的预检；
4. 使用临时文件加原子 rename 保存设置；
5. UI 标记“需要重启”；
6. 重启时关闭旧 Runtime，按最新配置重建环境。

预检或保存失败时保留旧设置，并在 UI 显示具体原因。设置保存成功到应用重启之前，UI 必须同时展示“当前运行环境”和“重启后的目标环境”，不能假装旧 Runtime 已经切换。

### 5.3 单版本替换

同一个 workspace owner 只允许存在一个 OHS 受管容器。daemon 重启并发现容器配置 hash 过期时：

1. 验证容器名称和 OHS owner label；
2. 确认没有仍在运行的旧 daemon 实例持有该容器；
3. 停止并删除旧容器；
4. 用最新配置创建同名容器；
5. 健康探测成功后发布环境句柄。

删除旧容器会清除容器内部未挂载的数据。设置页在保存可能导致重建的配置前明确提示；`/workspace` 和用户级 Skill 是宿主挂载，不随容器删除。

如果旧容器无法安全验证所有权或检测到其他 daemon 正在使用，启动失败并保持 fail-closed。系统不创建带 config hash 后缀的第二个容器。

### 5.4 可选的未来实时切换

第三阶段 3A 不实现无需重启的切换。当前继续使用“设置原子保存，重启后按最新配置创建环境”的简单模型。

确定性恢复只依赖一个提交点：

```text
settings 原子 rename 前崩溃 → 重启后读取完整旧配置
settings 原子 rename 后崩溃 → 重启后读取完整新配置
```

daemon 重启后结合当前 Settings 与 Docker owner/config labels 清理或重建资源，不持久化 `draining`、`switching`、source/target hash 或 affected owner 快照。

如果未来有明确用户价值再增加热切换，仍须保持单版本策略、设置提交前不静默终止终端或后台任务、设置提交后失败不回滚旧容器。该能力单独设计和实施，不能成为 3A 安全清理的前置条件。

## 6. 环境信息

宿主控制面和 Agent 执行面不能共用一个含义模糊的 cwd。环境句柄内部保存双路径绑定：

```ts
interface WorkspaceBinding {
  hostRoot: string;
  executionRoot: string;
}
```

- `hostRoot` 只提供给项目存储、Git/worktree、Skill 发现、Desktop 打开文件等宿主基础设施；
- `executionRoot` 提供给 Agent、ToolContext、Shell、文件工具和终端；
- 本机环境两者相同；
- Docker 环境分别是宿主绝对路径和 `/workspace`。

环境信息来自已启动并验证的环境：

```ts
interface EffectiveEnvironmentInfo {
  kind: "local" | "docker";
  hostOs: string;
  executionOs: string;
  shell: string;
  shellDialect: "powershell" | "cmd" | "posix";
  pathStyle: "windows" | "posix";
  cwd: string;
  homeDir: string;
  tempDir: string;
  mounts: Array<{ path: string; mode: "ro" | "rw"; purpose: string }>;
  networkMode: string;
  git?: { repository: boolean; branch?: string };
  limitations: string[];
}
```

环境信息不枚举可执行文件，也不暴露完整 `PATH`、凭据或秘密环境变量。Agent 需要某个程序时，在当前环境中按需检查。

本机示例：

```text
# Execution Environment
- Runtime: local
- OS: Windows
- Shell: PowerShell
- Path style: Windows
- Working directory: D:\code\project
- Home directory: C:\Users\<user>
- Temporary directory: C:\Users\<user>\AppData\Local\Temp
```

Docker 示例：

```text
# Execution Environment
- Runtime: Docker sandbox
- Host OS: Windows
- Execution OS: Linux
- Shell: /bin/sh
- Path style: POSIX
- Working directory: /workspace
- Home directory: /root
- Temporary directory: /tmp
- Mounts:
  - /workspace: read-write
  - /opt/openharness/skills: read-write
- Network: bridge
- Host paths outside the effective mount list are unavailable
```

Agent 系统提示词和全部工具必须绑定同一个 `ExecutionEnvironment`。不能先按宿主生成提示词，再把工具切换到 Docker。

## 7. Docker 挂载模型

### 7.1 受管挂载

用结构化类型代替内部原始 `-v` 字符串：

```ts
interface ManagedMount {
  purpose: "workspace" | "user_skills";
  source: string;
  target: "/workspace" | "/opt/openharness/skills";
  mode: "rw";
}
```

所有平台的 Docker 工作目录统一为 `/workspace`。Windows、macOS 和 Linux 的差异只存在于宿主 `source`。

| 用途 | 宿主来源 | 容器目标 | 模式 |
|---|---|---|---|
| 项目会话 | 项目规范化绝对路径 | `/workspace` | rw |
| 项目外根会话 | 当前根会话的受管 `xN` 目录 | `/workspace` | rw |
| 用户级 Skill | `getSkillsDir()` 的规范化结果 | `/opt/openharness/skills` | rw |

启动前必须安全创建用户级 Skill 目录。工作区必须已经存在且为目录，不能由 Docker `-v` 隐式创建。

### 7.2 `extraMounts`

Desktop 受管 Docker 环境当前不支持 `sandbox.docker.extraMounts`。解析到非空值时，预检直接失败并说明需要移除额外挂载。

CLI 原有高级 Sandbox 流程可以继续支持 `extraMounts`，但不属于本文的 Desktop 隔离承诺。Desktop 不能在存在任意额外挂载时显示“只开放工作区和 Skills”。

保留目标 `/workspace` 和 `/opt/openharness/skills` 不能被其他挂载覆盖，不能挂载 Docker Socket，也不能启用 privileged 容器。

### 7.3 配置指纹

可复用容器的配置指纹至少包含：

- 镜像；
- 网络、DNS 和代理；
- CPU 与内存限制；
- 每个受管挂载的规范化 source、target、mode 和 purpose；
- 容器内进程监督协议版本。

Skill 文件内容变化不改变指纹，因为 bind mount 会立即反映内容；Skill 根目录或挂载模式变化必须改变指纹。

### 7.4 文件系统影响

容器可以直接修改两个 rw 挂载中的宿主文件。容器自身 `/tmp`、`/root` 等未挂载路径不会直接修改宿主文件，但网络请求、端口和资源消耗仍可能产生外部影响。

## 8. 路径契约与文件工具

### 8.1 模型可见路径

Docker 模式下所有 Agent 输入和工具结果使用 POSIX 容器路径：

```text
工作区绝对路径：/workspace/src/index.ts
工作区相对路径：src/index.ts
用户 Skill：    /opt/openharness/skills/review/SKILL.md
```

相对路径以 `/workspace` 为基准。

### 8.2 文件操作

Read、Write、Edit、Glob 和 Grep 通过 `ExecutionEnvironment.fileOperations` 执行。Docker 后端在容器中完成：

- 路径解析与规范化；
- `..` 越界检查；
- 符号链接真实目标检查；
- 文件读写；
- Glob 和 Grep 搜索。

允许的根目录来自真实挂载表，即 `/workspace` 和 `/opt/openharness/skills`。文件工具不先使用 Windows `node:path` 解释 `/workspace/...`。

### 8.3 宿主路径展示

只有 Desktop 需要用资源管理器打开文件、展示宿主位置或生成宿主侧 diff 时，才调用 `environment.toHostPath(containerPath)`。转换必须基于真实挂载表，不能靠字符串猜测。

无法映射的容器路径不提供宿主“打开文件”操作。权限批准不能自动创建新挂载。

### 8.4 权限与旧路径规则

文件工具先由执行环境解析出结构化路径，再交给 PermissionChecker：

```ts
interface ResolvedEnvironmentPath {
  executionPath: string;
  hostPath?: string;
  mountPurpose: "workspace" | "user_skills" | "unmounted";
  mountMode?: "ro" | "rw";
}
```

Docker 模式的权限判断以规范化 `executionPath` 为主。审批 UI 首先显示容器路径；存在安全映射时，可以同时显示宿主路径，二者必须指向同一文件。

当前 Settings 结构中的 pathRules 使用以下路径规则：

- 相对规则始终相对工作区，Docker 中归一化到 `/workspace`；
- 本机环境允许当前平台的宿主绝对路径；
- Docker 环境只接受 `/workspace` 或 `/opt/openharness/skills` 下的 POSIX 绝对路径；
- Docker 环境发现 Windows 或其他宿主绝对路径时直接返回 `invalid_execution_path_rule`，不自动转换；
- deny 规则优先于 allow 规则；
- “当前 cwd 自动允许”指 executionRoot，不能用宿主 cwd 绕过。

diff 生成应通过环境文件能力读取旧内容；宿主控制面只负责展示和批准，不能再绕过环境直接读取任意输入路径。

## 9. Skill 访问与路径

### 9.1 加载和挂载

Skill 的发现、注册和 `SKILL.md` 内容读取继续由宿主控制面完成。Docker 启动时把 `getSkillsDir()` 返回的用户级 Skill 根目录读写挂载到 `/opt/openharness/skills`。

读写挂载允许 Agent 安装、修改和删除用户级 Skill，变更会影响其他项目和后续会话。用户级 Skill 不得保存 Token、密码或私钥。

### 9.2 Skill 路径呈现

SkillRegistry 内部保留规范化宿主来源路径。Skill 工具通过当前环境的 `presentPath()` 生成模型可用路径：

| Skill 来源 | `Skill file` | `Skill root` |
|---|---|---|
| 用户级 | `/opt/openharness/skills/<name>/SKILL.md` | `/opt/openharness/skills/<name>` |
| 项目级 | `/workspace/<relative>/SKILL.md` | `/workspace/<relative>` |
| Bundled | `(embedded)` | `(embedded)` |
| 未挂载的 Plugin Skill | `(unavailable in this environment)` | `(unavailable in this environment)` |

`Skill file` 和 `Skill root` 使用同一个通用路径呈现函数。Skill 工具本身不包含 Windows 或 Docker 特殊分支，也不能把无法访问的宿主绝对路径伪装成可用路径。

Plugin Skill 的 Markdown 正文仍可由宿主返回；附带引用和脚本在 Plugin 根目录未挂载时明确标记不可用。本阶段不新增 Plugin 目录挂载。

### 9.3 运行中变更

- 已有文件的修改通过 bind mount 立即对容器可见；
- Skill 与 ListSkills 每次调用前从不可变 bundled/plugin 基线重新构建 Registry，再扫描用户和项目目录，不能复制包含旧文件的共享 Registry；
- 来源优先级固定为 `bundled < plugin < user < project`，同名时后者覆盖前者；
- 删除和重命名 Skill 后，下一次 Skill/ListSkills 调用不能残留旧定义；
- 系统提示词中的 Skill 摘要在 Agent Runtime 创建时生成，新建或删除 Skill 后需重建 Runtime 才更新；
- Skill 内容更新不要求重建 Docker 容器；
- Skill 根路径或挂载配置变化按配置指纹处理。

## 10. 容器所有权与 lease

### 10.1 Environment Manager

daemon 持有唯一 `ExecutionEnvironmentManager`。Agent Runtime、Agent Terminal 和用户沙箱终端只能向 Manager 获取环境句柄，不能各自调用 `startSandboxRuntime()` 创建容器。

环境记录包含：

```text
environmentId
state: preparing | ready | failed | stopped
workspaceOwnerId
configHash
containerId
leases
```

### 10.2 Workspace Owner

`workspaceOwnerId` 决定哪些消费者共享环境：

- 项目复用模式：规范化项目工作区；
- 非复用模式：根会话 ID；
- 项目外根会话及其 fork：项目外根会话 ID；
- 非隔离子 Agent：继承父环境；
- 隔离 worktree 子 Agent：以自己的 worktree 路径形成新 owner。

同一 owner 只创建一个环境记录和一个受管容器。`configHash` 不参与容器名称；发现 hash 不同意味着原容器过期，按第 5.3 节替换，不能并行创建第二个版本。

### 10.3 Lease 规则

以下消费者取得 lease：

- 根 Agent Runtime；
- 共享环境的子 Agent Runtime；
- Agent Terminal；
- 跟随 Agent 环境的用户终端；
- 后台任务。

后台任务在进程结束前独立持有 background lease。release 必须幂等，只能清理该 owner 创建的进程。关闭一个终端只释放自己的 lease，不能停止其他终端、后台任务或 Agent 使用的环境。

环境只有在 lease 为零后才能释放。可复用容器释放环境句柄时保留容器，但必须停止本次 Runtime 启动的残留进程；临时容器在最后一个 lease 释放后停止并删除。

### 10.4 daemon 崩溃恢复

OHS 为容器和每个容器内 exec 写入 installation、daemon owner ID + generation、workspace owner、environmentId、runtimeId/jobId 与配置 hash 标记。installation ID 从规范化数据目录稳定派生，不新建数据库记录。

daemon 启动时在对外 ready 前执行 orphan reconciliation：

- 删除确认属于当前 installation、且由旧 daemon 实例遗留的临时容器；
- 清理可复用容器中属于旧 daemon owner ID + generation 的进程组；
- 不接管 hash 不匹配的旧环境；
- 无法验证所有权的容器只报告冲突，不停止或删除；
- 每次环境 acquire 都按当前最新 Settings 解析配置，hash 不匹配时仅在完整所有权验证后按单版本规则替换。

内存 lease 不做崩溃恢复。临时环境依赖内存 lease，daemon 重启后不接管；复用容器可以保留，但旧 daemon exec 必须清理。正常关闭会删除 `application_owner` 行，因此判断 daemon 实例必须同时比较随机 owner ID 和 generation，不能只比较 generation。

## 11. 交互终端

### 11.1 用户终端

默认用户终端取得当前会话的环境 lease：

```text
本机会话   → 本机 PTY
Docker 会话 → 当前 Docker 环境中的 PTY
```

终端“新建”菜单额外提供“在本机打开”。显式宿主终端使用 `runtime: local`，不改变 Agent 环境。

### 11.2 Agent Terminal

Agent Terminal 始终从 Agent 当前环境取得 lease。Docker 模式下忽略宿主 Shell 配置，只允许已经验证存在的容器 Shell。

### 11.3 Docker PTY

Docker 交互终端必须使用真实 PTY/TTY 通道，不能用普通 stdin/stdout pipe 冒充。后端需支持：

- 交互 Shell，例如 `/bin/sh -i` 或 `/bin/bash -i`；
- 输入和实时输出；
- resize 和 `SIGWINCH`；
- Ctrl-C/interrupt；
- EOF；
- terminate；
- 关闭单个 exec 会话时停止其容器内进程组，不停止共享容器。

当前 `LocalTerminalProvider.createSandboxTerminal()` 的普通管道实现不满足该契约，应列为待替换实现。

### 11.4 Terminal 协议的项目外支持

`TerminalCreateRequest` 使用显式判别作用域：

```ts
type TerminalScope =
  | { kind: "project"; projectId: string }
  | { kind: "session"; sessionId: string };
```

`TerminalSessionInfo.projectId` 改为可选，并始终保存 scope 和解析后的 sessionId/projectId。

兼容旧请求时：只有 projectId 时解释为 project scope；同时出现 projectId 和 sessionId 时，必须验证 Session 确实属于该 Project 且 cwd 一致，否则拒绝。新客户端只能发送一种判别作用域。

服务端从 ProjectStore 或 SessionStore 解析可信 cwd，不信任渲染进程任意提供的 cwd。若请求同时携带 cwd，只允许它等于解析后的 cwd。

Agent Terminal Host 使用所属 Agent 环境的 cwd，不要求会话具有 projectId。因此项目外会话能够创建 Agent Terminal 和用户集成终端。

## 12. 项目外会话、fork 与子 Agent

### 12.1 根会话

独立创建的项目外根会话在系统 Documents 下分配独立目录：

```text
%USERPROFILE%\Documents\OpenHarness\YYYY-MM-DD\xN
```

会话没有 projectId，但保存 cwd 和：

```text
workspaceMode: outside_project
workspaceOwnerId: outside-root-session-id
```

Docker 只把该 `xN` 目录挂载为 `/workspace`，不能挂载整个 Documents。

### 12.2 Fork

项目外 fork 有意继承源会话 cwd 和 workspaceOwnerId，以保持文件连续性。它有新的 sessionId，但不分配新的 `xN` 目录。

“不同项目外会话不共享目录”只适用于独立创建的根会话，不适用于 fork。

### 12.3 子 Agent

非隔离子 Agent 继承父 cwd、workspaceOwnerId 和执行环境。

明确请求隔离的子 Agent 只有在成功创建独立 Git worktree 后才启动，并以该 worktree 建立新的 environment owner。不是 Git 仓库、worktree 创建失败或环境准备失败时返回 `isolation_unavailable`，不静默降级为共享父工作区。调用方可以另行发起非隔离子 Agent，但不能把失败的隔离请求自动改成非隔离。

### 12.4 清理

- 会话创建失败时，只删除本次刚分配且仍为空的目录；
- 归档会话不删除工作区；
- 删除一个 fork 不删除共享工作区；
- 删除根会话时，只要仍有 fork、子会话、Agent Runtime、后台任务、Agent Terminal、用户沙箱终端或显式宿主终端引用该 cwd，就不能删除工作区；
- 默认删除会话不删除非空工作区；
- 删除工作区是独立操作，显示绝对路径并请求用户确认。

项目外工作区默认不是 Git 仓库，branch、worktree 和 review 功能显示为不可用；普通 Agent、文件和终端能力继续工作。

## 13. 自然语言宿主路径请求

Docker 模式下，未指定路径的文件请求默认以 `/workspace` 为范围。

用户说“看看我的桌面有哪些文档”时，当前版本：

1. 不访问 Windows Desktop；
2. 在 `/workspace` 查找；
3. 明确说明实际查找范围是 Docker 工作区。

当前版本不支持临时或动态挂载宿主桌面等额外目录。用户明确要求访问未挂载宿主目录时，Agent 说明该目录在当前沙箱不可见，并提示用户把所需文件复制到工作区或切换到本机环境。

权限批准不能让容器访问未挂载目录，也不会动态重建容器。

## 14. Fail-closed 范围

Docker 环境不可用、配置不匹配或环境句柄失效时，以下入口全部失败：

- Bash 和 argv 进程；
- 后台 Shell；
- Read、Write、Edit、Glob 和 Grep；
- Agent Terminal；
- 默认用户集成终端；
- Hook 和 Cron；
- LSP 和 ripgrep；
- MCP stdio；
- 子 Agent 和计划任务恢复后发起的工作负载；
- 用户级 Skill 脚本。

上述清单用于说明现有入口，真正的完整性由工具执行域注册检查保证：所有 `environment` 工具都必须取得当前环境能力，否则不向模型注册。新增工具不会因为忘记更新清单而自动获得宿主执行权限。

`control_plane` 工具只能使用第 3.8 节声明的数据范围和独立权限策略。附件 ID、Skill 元数据或远程生成服务不能接受任意宿主路径。失败结果应包含环境类型、失败阶段和可操作原因，不启动对应宿主进程。显式选择的宿主终端不属于 Docker fail-closed 范围。

## 15. 当前实现与差距

当前已经具备：

- Docker Runtime 启动和容器复用；
- Windows 工作区到 `/workspace` 的挂载；
- Bash、后台进程、Hook、Cron、LSP 和 MCP stdio 的 Sandbox 进程入口；
- Docker active 时文件工具在容器内读写与搜索；
- 容器配置 hash 和不匹配拒绝复用；
- 项目外根会话的受管 cwd；
- Skill 的宿主发现和按调用刷新；
- Terminal Provider 的初步 `runtime: sandbox` 分支。

进入实现前已经确认的差距：

1. 设置页运行环境仍是静态占位。
2. Desktop 用户终端和 Agent Terminal 都固定为 local。
3. Docker Terminal 使用普通 pipe，缺少真实 PTY。
4. DaemonTerminalService 要求 projectId，项目外终端会失败。
5. Agent 提示词目前按宿主环境生成，并且早于 Sandbox attach。
6. 文件工具仍先以宿主路径解析输入。
7. Sandbox Session 是全局 Map，没有共享环境 lease/ref-count 生命周期。
8. 用户 Skill 目录尚未以受管 rw 方式挂载。
9. Skill file/root 当前返回宿主路径。
10. `extraMounts` 仍可直接形成任意 `-v` 参数。
11. Docker 配置目前允许不可用时降级宿主。
12. Native Plugin Tool Host 仍可直接在宿主启动进程。
13. `ImageToText(image_path)` 仍可能直接读取宿主路径。
14. 工具定义还没有强制执行域元数据和注册检查。
15. ToolContext cwd、宿主 Git/Skill cwd 和容器 cwd 尚未通过 WorkspaceBinding 分离。
16. PermissionChecker 仍按宿主路径处理文件参数和 pathRules。
17. 项目外 fork 会共享 cwd，但现有模型没有持久 workspaceOwnerId。
18. 可复用容器和 exec 缺少完整 owner 标记及 daemon orphan reconciliation。

## 16. 目标行为矩阵

| 操作 | 本机环境 | Docker 环境 |
|---|---|---|
| Agent 短命令 | 宿主 Shell | 容器 `/bin/sh -c` |
| Agent 后台命令 | 宿主进程 | 当前容器进程 |
| Agent Terminal | 本机 PTY | 当前容器 PTY |
| Read/Write/Edit | 宿主路径 | 容器路径与容器 IO |
| Glob/Grep | 宿主路径 | 容器路径与容器搜索 |
| 默认用户终端 | 配置的本机 Shell | 配置的容器 Shell |
| 显式宿主终端 | 配置的本机 Shell | 配置的本机 Shell |
| 用户级 Skill | 宿主 Skill 目录 | `/opt/openharness/skills` rw |
| Native Plugin Tool | 宿主 Plugin Host | 第一期禁用，后续接入环境执行 |
| ImageToText 路径输入 | 宿主文件能力 | 通过环境文件能力读取容器路径 |
| 附件 ID 与 ImageGeneration | 受控宿主服务 | 受控宿主服务，不接受任意宿主路径 |
| 项目外根会话 | 独立受管 cwd | 独立 cwd → `/workspace` |
| 项目外 fork | 继承源 cwd | 共享源环境 owner |
| 非隔离子 Agent | 继承父环境 | 继承父环境 |
| 隔离 worktree 子 Agent | 成功创建独立 worktree 后运行 | 成功创建独立 worktree 和环境后运行；失败则拒绝 |
| Git worktree 管理 | 宿主基础设施 | 宿主基础设施 |
| Desktop/daemon | 宿主 | 宿主 |

## 17. UI 文案

```text
智能体运行环境
选择 Agent 的命令、文件工具和可环境化后台任务在本机还是 Docker 沙箱中运行。

本机
直接使用当前系统环境。

Docker 沙箱
当前工作区和用户级 Skills 将读写挂载到容器。容器中的修改会同步到宿主文件。

集成终端 Shell
选择用户手动新建的本机集成终端使用的 Shell。第一期它不跟随 Agent 的 Docker 环境。
```

终端菜单：

```text
新建本机终端
└─ 使用“集成终端 Shell”配置
```

第一期保存设置后：

```text
设置已保存，重启 OpenHarness 后生效。若现有沙箱配置已经过期，重启时将使用最新配置重建；容器内部未挂载的数据会被清除。
```

第一期 Docker 模式的终端区域显示：

```text
Docker 交互终端将在下一阶段提供。当前可显式打开本机终端；Agent Terminal 在 Docker 模式下不可用。
```

## 18. 分期实现

### 18.1 第一期：安全执行闭环

目标是让所有仍可调用的 Agent 本地工作负载可靠地留在 Docker 中。设置变化重启后生效。

- [x] 建立 `@openharness/environment` 契约和 WorkspaceBinding；
- [x] `agent-runtime` 接收环境能力，并在环境 ready 后构建提示词；
- [x] 设置页接入 local/docker，使用 `desktop_managed` 配置解析；
- [x] 所有 Docker 平台统一 `/workspace`；
- [x] 挂载 workspace 和用户级 Skills，拒绝 Desktop `extraMounts`、Docker Socket 和 privileged；
- [x] Shell、文件工具、Command Hook 和后台 Shell 通过当前 Docker Session 执行；
- [x] 文件工具直接接受容器路径，PermissionChecker 使用环境路径风格；
- [x] Skill file/root 使用环境路径呈现，并从不可变基线刷新；
- [x] `ImageToText(image_path)` 接入环境字节读取；
- [x] 工具注册增加 execution domain；Native Plugin Tool 与 Agent Terminal 在 Docker 第一期禁用；
- [x] 默认用户终端保持本机运行，界面明确说明与 Agent 沙箱分离；
- [x] Docker 不可用或配置不合法时 fail-closed；
- [x] 项目外会话使用已有受管 cwd，支持 Docker Shell 和文件能力；
- [x] 配置变化要求重启；同一 owner 只保留最新容器版本；
- [x] 远程 HTTP/SSE MCP 受环境网络策略约束；Docker 禁网时不连接；
- [x] LSP 的文件读取与搜索通过环境文件能力执行；
- [x] MCP stdio 使用 hostRoot 定位同一个活动 Docker Session，进程在容器中启动。

第一期的安全目标已经达到：环境能力不可用时不会退回宿主执行。

第一期不引入共享终端 lease、Docker PTY、Session 环境快照、运行中热切换或多配置容器。

### 18.2 第二期：统一终端体验

- [x] 实现 Docker PTY；
- [x] Agent Terminal 跟随 Agent 环境；
- [x] 默认用户终端跟随 Agent 环境，并保留显式本机入口；
- [x] Terminal 协议支持 project/session 判别作用域；
- [x] 项目外用户终端和 Agent Terminal；
- [x] daemon 持有唯一 Environment Manager、workspace owner 和内存 lease；
- [x] 同一 owner 的 Agent、多个终端和后台任务共享单个环境；
- [x] 关闭终端、Agent 和后台进程时只释放自己的 lease；
- [x] Docker PTY 覆盖输入、实时输出、resize、Ctrl-C、EOF 和 terminate；
- [x] 非隔离子 Session 通过引用计数 alias 使用根 Session 的活动容器。

第二期 lease 只存在于 daemon 内存中。运行中切换、持久 lease 和 daemon 崩溃恢复仍属于第三期。

### 18.3 第三期：生命周期加固

第三期继续拆成独立子阶段，避免把环境安全、插件执行、危险目录删除和 CI runner 差异绑成一次改造。

3A 先完成最小生命周期安全闭环：

- Settings 使用同目录临时文件和原子 rename；
- 容器与 exec 写入可验证 installation、workspace、environment 和 daemon 复合身份；
- daemon ready 前执行保守 orphan reconciliation；
- 真实 Docker E2E 覆盖临时容器、复用容器旧 exec、未知所有权和单版本替换。

其余能力分别规划：

- 3B：Native Plugin Tool 环境化后按能力重新启用；
- 3C：Skill 变更感知、工作区引用统计和独立清理入口；
- 3D：在确实具有对应 Docker daemon 的 runner 上接入跨平台真实 E2E。

无需重启的热切换暂缓，待出现明确用户价值后单独设计。第三期仍使用单一最新容器版本，不增加旧配置恢复、多版本并存或持久 lease。

## 19. 验收与测试分层

### 19.1 单元测试

- 配置优先级覆盖五层来源；
- 当前 Settings 字段结构正常加载，`_formatVersion`、废弃字段和未知字段明确失败；
- `desktop_managed` 拒绝 SRT/extraMounts，`cli_advanced` 保持 SRT 能力；
- SRT 配置在 Desktop 显示不支持，不能静默变成本机；
- `ProjectRecord.defaultShell` 只作为本机 Shell；
- `local/docker` 与 Terminal `local/sandbox` 映射唯一；
- WorkspaceBinding 分离 hostRoot 和 executionRoot；
- `/workspace`、Skills、相对路径、`..` 和符号链接边界；
- pathRules 的相对、可映射绝对和不可映射绝对规则；
- Skill file/root 对用户级、项目级、Bundled 和未挂载 Plugin 的呈现；
- Skill Registry 删除、重命名和 `bundled < plugin < user < project` 覆盖；
- `extraMounts` 在 Desktop 模式被拒绝；
- 保留挂载目标、Docker Socket 和 privileged 配置被拒绝；
- 配置指纹包含规范化受管挂载；
- 同一 owner 的容器身份不包含 hash，过期版本不会并存；
- 工具执行域缺失时默认 environment，Docker 中无环境能力则不注册；
- Environment Manager 的 owner、Agent/Terminal/background lease 和状态迁移；
- 项目外根会话、fork、非隔离 child 和 worktree child 的 owner 规则；
- 隔离 worktree 创建失败返回 `isolation_unavailable`。

### 19.2 协议与服务集成测试

- 新 TerminalCreateRequest 只接受 project 或 session 判别作用域；
- 兼容请求同时包含 projectId/sessionId 时验证关联和 cwd；
- 服务端拒绝与项目或会话不一致的 cwd；
- 项目外用户终端和 Agent Terminal 能创建；
- 关闭单个终端只释放自己的 lease；
- 第一阶段设置保存后标记需重启，运行环境不伪装成已切换；
- 用户级和项目级 Settings 原子保存，故障只留下完整旧文件或完整新文件；
- 重启后旧会话和新会话都使用最新配置；
- 过期的已验证 OHS 容器被最新配置替换，不产生第二个版本；
- 无法验证 owner 的同名容器不删除并导致 fail-closed；
- daemon 启动时只删除当前 installation 的旧临时容器，只清理旧 daemon 复合身份的 exec；
- settings rename 前后崩溃时分别读取完整旧配置或完整新配置，不依赖持久切换状态；
- 显式宿主终端打开时不能删除其工作区；
- Native Plugin Tool 在第一期 Docker 模式不注册；
- `ImageToText(image_path)` 不调用宿主 readFile；
- attachment/ImageGeneration control-plane 工具不能读取任意宿主路径；
- Skill/ListSkills 的刷新时机符合第 9.3 节；
- 从完整模型可见工具注册表断言所有 environment 工具 fail-closed，而不是维护手写测试名单。

### 19.3 真实 Docker E2E

- Windows、Linux 和 macOS 支持环境中的容器 cwd 都是 `/workspace`；
- Bash、文件工具、Agent Terminal 和默认用户终端使用同一 container ID；
- Read/Write/Edit/Glob/Grep 直接接受容器路径；
- 工作区和用户 Skill 的写入同步到宿主；
- 未挂载宿主目录不可见；
- 用户 Skill 目录不存在时能安全创建并挂载；
- 配置 hash 不匹配时旧容器被最新版本替换，且不存在第二个 owner 容器；
- Docker PTY 支持交互、resize、Ctrl-C、EOF 和 terminate；
- 关闭一个终端不影响 Agent 或其他终端；
- 最后一个临时环境 lease 释放后容器被删除；
- 可复用容器保留，但本 Runtime 的残留进程被清理；
- 项目外根会话挂载自己的 xN，fork 共享，独立根会话不共享；
- 隔离 worktree 创建失败时没有共享父工作区的 child 被启动；
- daemon 重启后清理可确认的孤儿临时容器和旧进程；
- Docker 不可用时所有受管入口 fail-closed。

仅在具有对应平台和 Docker daemon 的 CI Job 中运行真实 E2E；其他环境明确 skip，不把 skip 计为通过证据。

## 20. 不在本阶段范围内

- 动态挂载桌面、下载目录或其他任意宿主目录；
- Desktop 受管环境中的 `extraMounts`；
- 用户 Skill 的只读或按需挂载；
- Plugin 根目录自动挂载；
- Docker 镜像内安装 PowerShell；
- Shell 语法自动翻译；
- 环境信息枚举全部可执行文件或完整 PATH；
- 把 Desktop、daemon 或完整 Agent 控制程序迁入 Docker；
- 为项目外工作区自动初始化 Git 仓库；
- Desktop 的 SRT 环境选项。
- Session 历史环境配置快照；
- 同一 workspace owner 的多版本容器并存；
- 恢复旧会话创建时使用的旧镜像、网络或挂载配置。
