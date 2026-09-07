# Agent 运行环境与集成终端设计

> 状态：已根据独立审查完整修订，等待最终审查
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

Desktop 当前只展示“本机”和“Docker”。现有 SRT 配置继续服务 CLI 等高级入口，不在本次 Desktop 设置改造范围内。

### 4.2 Terminal 配置

新增用户设置：

```ts
terminal: {
  localShell?: string;
  dockerShell?: "/bin/sh" | "/bin/bash";
}
```

本机和 Docker 的 Shell 偏好分别保存。Docker Shell 必须在目标容器中探测存在后才能使用。

现有 `ProjectRecord.defaultShell` 继续作为项目级本机 Shell 覆盖，不改写为 Docker Shell。旧值无需迁移文件，读取时按“本机 Shell”解释。

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

Agent 在 Docker 中不能请求宿主可执行文件。其他 Shell 路径只有通过容器内存在性检查和允许列表后才能使用。

### 4.3 Session 环境快照

新增会话运行元数据：

```ts
metadata.runtime.executionEnvironment?: "local" | "docker";
metadata.runtime.executionConfigHash?: string;
```

新会话创建时保存当时解析出的环境类型和配置指纹。已有会话缺少该字段时，在第一次 warm 前按当前有效设置解析并写入快照。

全局默认设置变化只影响之后创建的会话。已有会话保留自己的快照，直到用户明确执行“使用当前默认环境重新启动会话”。

### 4.4 配置优先级

环境解析使用唯一入口 `resolveExecutionEnvironmentConfig()`，优先级由低到高为：

1. 默认值；
2. 用户级 `settings.json`；
3. 项目级 `settings.json`，项目外会话跳过；
4. 会话环境快照或会话级覆盖；
5. `OPENHARNESS_SANDBOX_*` 环境变量；
6. CLI 显式覆盖。

进程环境变量和 CLI 覆盖属于运行时运维控制，可以暂时覆盖会话快照，但不得静默改写持久化快照。

### 4.5 协议兼容

Terminal 协议现有 `runtime: "local" | "sandbox"` 保持兼容：

- `local` 表示显式宿主终端；
- `sandbox` 表示附着到所属会话的有效 Docker 环境。

Desktop 内部的环境类型使用 `local | docker`。协议层只在边界处完成 `docker → sandbox` 映射，不能把二者作为两套独立配置。

## 5. 环境创建与切换事务

### 5.1 新会话

```text
解析候选配置
    ↓
校验挂载与 Docker 配置
    ↓
准备候选环境
    ↓
执行健康探测
    ↓
生成 EffectiveEnvironmentInfo
    ↓
保存 Session 环境快照
    ↓
发布环境句柄并创建 Agent
```

任一步失败都关闭候选环境，不创建 Agent，不执行任何宿主回退命令。

### 5.2 修改全局默认环境

设置页切换全局默认值时：

1. 归一化候选设置；
2. 校验 Docker CLI、daemon、镜像、挂载和保留路径；
3. 准备并探测候选环境；
4. 使用临时文件加原子 rename 保存设置；
5. 发布新的全局默认值；
6. 关闭仅用于预检的候选环境。

失败时保留旧设置，并在 UI 显示具体原因。已有会话和终端不会迁移。

### 5.3 重新启动已有会话

只有会话没有活跃工作负载时才能切换。活跃工作负载包括：

- 正在执行的 Agent run；
- 后台 Shell；
- Agent Terminal；
- 跟随 Agent 环境的用户终端；
- 共享该环境的子 Agent。

显式宿主终端不占用 Docker 环境，因此不阻止切换。

切换顺序为：准备并探测目标环境 → 原子更新会话快照和活动环境指针 → 释放旧环境。发布前失败时继续使用旧环境；发布后清理失败只记录清理错误，不能把新环境回滚成不一致状态。

### 5.4 可复用容器配置不匹配

配置指纹不匹配时返回 `rebuild_required`，不复用旧容器，也不静默删除。Desktop 显示旧容器与新配置不一致，并提供明确的“重建沙箱”操作。

重建前必须确认该容器没有环境 lease 或活跃工作负载。重建只删除 OHS 通过名称和 label 双重验证的目标容器。

## 6. 环境信息

环境信息来自已启动并验证的环境：

```ts
EffectiveEnvironmentInfo {
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
ManagedMount {
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
- Skill 工具每次调用前刷新磁盘定义；
- ListSkills 每次调用前刷新目录清单；
- 系统提示词中的 Skill 摘要在 Agent Runtime 创建时生成，新建或删除 Skill 后需重建 Runtime 才更新；
- Skill 内容更新不要求重建 Docker 容器；
- Skill 根路径或挂载配置变化按配置指纹处理。

## 10. 容器所有权与 lease

### 10.1 Environment Manager

daemon 持有唯一 `ExecutionEnvironmentManager`。Agent Runtime、Agent Terminal 和用户沙箱终端只能向 Manager 获取环境句柄，不能各自调用 `startSandboxRuntime()` 创建容器。

环境记录包含：

```text
environmentId
state: preparing | ready | draining | stopped | failed
workspaceOwnerId
configHash
containerId
leases
activeJobs
```

### 10.2 Workspace Owner

`workspaceOwnerId` 决定哪些消费者共享环境：

- 项目复用模式：规范化项目工作区；
- 非复用模式：根会话 ID；
- 项目外根会话及其 fork：项目外根会话 ID；
- 非隔离子 Agent：继承父环境；
- 隔离 worktree 子 Agent：以自己的 worktree 路径形成新 owner。

同一 owner 与同一 `configHash` 只创建一个环境记录。

### 10.3 Lease 规则

以下消费者取得 lease：

- 根 Agent Runtime；
- 共享环境的子 Agent Runtime；
- Agent Terminal；
- 跟随 Agent 环境的用户终端。

后台进程记录为 `activeJobs`，由创建它的 Runtime 管理。关闭一个终端只释放自己的 lease，不能停止其他终端或 Agent 使用的环境。

环境只有在 lease 为零且 activeJobs 已清理后才能释放。可复用容器释放环境句柄时保留容器，但必须停止本次 Runtime 启动的残留进程；临时容器在最后一个 lease 释放后停止并删除。

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

`TerminalCreateRequest` 和 `TerminalSessionInfo` 的 `projectId` 改为可选。创建请求必须能由以下任一作用域解析：

```text
项目终端：projectId
会话终端：sessionId
```

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

非隔离子 Agent 继承父 cwd、workspaceOwnerId 和执行环境。隔离子 Agent 获得新的 Git worktree 时，使用该 worktree 作为 workspace，并取得新的环境 owner；无法创建 worktree 时按现有 child environment 规则共享父工作区。

### 12.4 清理

- 会话创建失败时，只删除本次刚分配且仍为空的目录；
- 归档会话不删除工作区；
- 删除一个 fork 不删除共享工作区；
- 删除根会话时，只要仍有 fork、子会话或活跃环境引用，就不能删除工作区；
- 默认删除会话不删除非空工作区；
- 删除工作区是独立操作，显示绝对路径并请求用户确认。

项目外工作区默认不是 Git 仓库，branch、worktree 和 review 功能显示为不可用；普通 Agent、文件和终端能力继续工作。

## 13. 自然语言宿主路径请求

Docker 模式下，未指定路径的文件请求默认以 `/workspace` 为范围。

用户说“看看我的桌面有哪些文档”时，当前版本：

1. 不访问 Windows Desktop；
2. 在 `/workspace` 查找；
3. 明确说明实际查找范围是 Docker 工作区。

当前版本不支持临时或动态挂载宿主桌面等额外目录。用户明确要求访问未挂载宿主目录时，Agent说明该目录在当前沙箱不可见，并提示用户把所需文件复制到工作区或切换到本机环境。

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

失败结果应包含环境类型、失败阶段和可操作原因，不启动对应宿主进程。显式选择的宿主终端不属于 Docker fail-closed 范围。

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
12. 会话元数据没有 executionEnvironment 快照和 config hash。
13. 项目外 fork 会共享 cwd，但旧验收没有区分根会话和派生会话。

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
| 项目外根会话 | 独立受管 cwd | 独立 cwd → `/workspace` |
| 项目外 fork | 继承源 cwd | 共享源环境 owner |
| 非隔离子 Agent | 继承父环境 | 继承父环境 |
| 隔离 worktree 子 Agent | 独立 worktree | 独立 worktree 环境 |
| Git worktree 管理 | 宿主基础设施 | 宿主基础设施 |
| Desktop/daemon | 宿主 | 宿主 |

## 17. UI 文案

```text
智能体运行环境
选择 Agent 的命令、文件工具、后台任务和默认终端在本机还是 Docker 沙箱中运行。

本机
直接使用当前系统环境。

Docker 沙箱
当前工作区和用户级 Skills 将读写挂载到容器。容器中的修改会同步到宿主文件。

集成终端 Shell
选择新终端在当前 Agent 环境中使用的 Shell。Docker 模式只显示容器内可用的 Shell。
```

终端菜单：

```text
新建终端
├─ 在当前 Agent 环境中打开（默认）
└─ 在本机打开
```

配置不匹配：

```text
现有沙箱与当前配置不一致，需要重建后才能使用。重建会清除容器内部未挂载的数据，但不会删除工作区和用户级 Skill 文件。
```

## 18. 验收与测试分层

### 18.1 单元测试

- 配置优先级覆盖所有六层来源；
- 旧 `ProjectRecord.defaultShell` 只作为本机 Shell；
- 旧会话缺少环境字段时生成一次快照；
- `local/docker` 与 Terminal `local/sandbox` 映射唯一；
- `/workspace`、Skills、相对路径、`..` 和符号链接边界；
- Skill file/root 对用户级、项目级、Bundled 和未挂载 Plugin 的呈现；
- `extraMounts` 在 Desktop 模式被拒绝；
- 保留挂载目标、Docker Socket 和 privileged 配置被拒绝；
- 配置指纹包含规范化受管挂载；
- Environment Manager 的 owner、lease、activeJobs 和状态迁移；
- 项目外根会话、fork、非隔离 child 和 worktree child 的 owner 规则。

### 18.2 协议与服务集成测试

- TerminalCreateRequest 支持 projectId 或 sessionId 作用域；
- 服务端拒绝与项目或会话不一致的 cwd；
- 项目外用户终端和 Agent Terminal 能创建；
- 关闭单个终端只释放自己的 lease；
- 全局默认设置只影响新会话；
- 会话环境切换在活跃工作存在时被拒绝；
- 候选环境准备或设置保存失败时保留旧环境；
- `rebuild_required` 不复用、不删除错误容器；
- Skill/ListSkills 的刷新时机符合第 9.3 节；
- 每个 fail-closed 入口都断言没有调用宿主 spawn。

### 18.3 真实 Docker E2E

- Windows、Linux 和 macOS 支持环境中的容器 cwd 都是 `/workspace`；
- Bash、文件工具、Agent Terminal 和默认用户终端使用同一 container ID；
- Read/Write/Edit/Glob/Grep 直接接受容器路径；
- 工作区和用户 Skill 的写入同步到宿主；
- 未挂载宿主目录不可见；
- 用户 Skill 目录不存在时能安全创建并挂载；
- 配置 hash 不匹配返回 `rebuild_required`；
- Docker PTY 支持交互、resize、Ctrl-C、EOF 和 terminate；
- 关闭一个终端不影响 Agent 或其他终端；
- 最后一个临时环境 lease 释放后容器被删除；
- 可复用容器保留，但本 Runtime 的残留进程被清理；
- 项目外根会话挂载自己的 xN，fork 共享，独立根会话不共享；
- Docker 不可用时所有受管入口 fail-closed。

仅在具有对应平台和 Docker daemon 的 CI Job 中运行真实 E2E；其他环境明确 skip，不把 skip 计为通过证据。

## 19. 不在本阶段范围内

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
