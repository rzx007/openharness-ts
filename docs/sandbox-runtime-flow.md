# Agent 运行环境与 Docker 调用链

> 状态：第三期 3A 实现说明。Desktop 已具备统一 `ExecutionEnvironment`、共享 lease、原子 Settings 保存和 daemon 启动孤儿清理；CLI 高级模式继续保留原有 SRT/Docker 能力。

## 1. 两个设置互不混用

- **智能体运行环境**决定 Agent 的命令、脚本和文件工具在哪里执行。Desktop 当前支持“本机”和“Docker 沙箱”。
- **集成终端 Shell**决定新终端在对应环境中使用的 Shell：本机用本机 Shell，Docker 用容器 Shell。用户仍可显式选择“在本机打开”。

因此，选择 Docker 后：

- Agent 看到 Linux、`/bin/sh` 和 `/workspace`；
- 用户默认集成终端和 Agent `TerminalOpen` 使用当前 Docker 环境的真实 PTY；
- 显式“在本机打开”使用宿主 PTY，不改变 Agent 环境；
- Native Plugin Tool 在 Docker Agent 中仍不可用；
- 设置保存后需要重启 OpenHarness，新环境不会伪装成立即生效。

## 2. Desktop 启动顺序

```text
Desktop 启动内置 daemon
  → executionSurface = desktop_managed
  → 取得现有 application owner lease
  → 从 daemon 数据目录派生 installation ID
  → reconcileDockerOrphans()
       删除本 installation 的旧临时容器
       清理复用容器中的旧 daemon exec
       未验证资源只报告，不删除
  → daemon 按 Session.cwd 读取 Settings
  → resolveExecutionEnvironmentConfig()
       local  → 本机环境
       docker → 严格 Docker 环境
       srt / extraMounts → 拒绝，不降级
  → createWorkspaceBinding()
       hostRoot      = Session.cwd
       executionRoot = local ? Session.cwd : /workspace
  → resolveEnvironmentOwner()
  → ExecutionEnvironmentManager.acquire()
       同 owner + 同 configHash → 复用 ready 环境并增加 lease
       没有环境              → createExecutionEnvironment()
                                 preflight → 挂载 → 启动容器 → ready
  → 创建 Tool Registry、PermissionChecker 和 system prompt
  → 向模型开放与当前环境兼容的工具
```

项目外会话也走同一条流程。它已有一个位于“文档/OpenHarness/日期/xN”的受管 cwd，该目录直接成为 `hostRoot`，不需要 `projectId` 或另一套 Projectless Runtime。

Docker 不可用、配置不合法或容器启动失败时，环境创建失败，Agent 不会退回宿主执行。

同一个 owner 的 Agent、Agent Terminal、用户环境终端和后台任务共享一个 EnvironmentHandle：

```text
workspace owner
  └─ ExecutionEnvironmentManager
       ├─ Agent lease
       ├─ Agent Terminal lease
       ├─ user terminal lease
       └─ background job lease
```

关闭一个消费者只释放自己的 lease。最后一个 lease 释放后，临时容器停止并删除；项目复用容器保留，但本次 Runtime 的残留进程会被清理。

## 3. Docker 路径契约

Desktop 受管 Docker 只创建两条读写挂载：

| 容器路径 | 宿主来源 | 权限 | 用途 |
|---|---|---|---|
| `/workspace` | 当前 Session 的 cwd | `rw` | 工作区 |
| `/opt/openharness/skills` | 用户级 Skills 目录 | `rw` | 用户 Skills |

所有平台的容器工作目录统一为 `/workspace`。Agent 和工具使用容器路径，不接触 Windows 路径拼接。

路径解析由环境统一完成：

```text
模型输入路径
  → environment.paths.resolve(path, operation)
  → 判断是否属于 workspace / user_skills 挂载
  → PermissionChecker 检查 POSIX 路径与权限
  → environment.files 或 environment.process 执行
```

`Read`、`Write`、`Edit`、`Glob`、`Grep` 直接接受 `/workspace/...` 和 `/opt/openharness/skills/...`。`..` 逃逸、`/etc/...`、Windows 绝对路径和其他未挂载位置会被拒绝。真实 I/O 在容器中执行；挂载目录中的修改会同步回宿主。

## 4. 命令执行

`Bash` 在受管环境中调用 `environment.process.execShell()`：

```text
Bash("pwd")
  → resolve workdir = /workspace
  → DockerSandboxSession.execCommand([/bin/sh, -c, pwd])
  → 宿主启动 docker exec
       宿主进程 cwd = hostRoot
       容器 -w      = /workspace
  → 输出返回 QueryEngine
```

这两个 cwd 必须分开。把 `/workspace` 当作宿主 `docker.exe` 的 cwd 会在 Windows 上直接启动失败。

Command Hook 和后台 Shell 仍由宿主控制面创建，但它们携带 Session 的宿主 cwd、settings 和 sessionId，通过同一个活动 Docker Session 执行。LSP 在 Docker 中通过 `environment.files` 读取和搜索，不直接读取宿主路径。

## 5. 文件工具与 ImageToText

文件工具不再先把容器路径翻译成宿主路径：

```text
Read / Write / Edit / Glob / Grep
  → environment.paths
  → environment.files
       local  → HostFileOperations
       docker → DockerFileOperations → docker exec
```

`ImageToText(image_path)` 同样先解析环境路径，再通过 `environment.files.readBytes()` 读取。它不能用路径读取未挂载的宿主文件。

附件继续采用 `attachment://<assetId>`（工具参数中为 `attachment_id`），由宿主 Attachment Service 做会话授权和读取；附件不会因为 Agent 在 Docker 中运行就变成任意宿主路径。

## 6. Skill 加载与路径呈现

Skill Registry 每次刷新都从不可变来源重建，覆盖顺序是：

```text
bundled < plugin < user < project
```

已删除的 user/project Skill 不会残留在旧 Map 中。返回 Skill 内容时：

- 用户 Skill 显示 `/opt/openharness/skills/...`；
- 项目 Skill 显示 `/workspace/...`；
- Bundled Skill 显示 `(embedded)`；
- 未挂载 Plugin Skill 保留 Markdown 正文，但 file/root 显示 `(unavailable in this environment)`。

`Skill file` 和 `Skill root` 使用同一个 `environment.paths.presentHostPath()` 转换，不分别维护规则。

## 7. 工具执行域

每个工具声明实际运行位置：

- `environment`：必须由当前执行环境提供进程或文件能力；
- `control_plane`：由宿主控制面提供，但仍受当前环境的网络和权限策略约束。

未声明执行域的扩展工具默认是 `environment + local only`，因此不会意外出现在 Docker Agent 中。Docker `networkMode=none` 时，WebSearch、WebFetch 和远程 MCP 等需要网络的控制面工具会隐藏或拒绝调用。

当前安全限制：

- Native Plugin Tool Host 不在 Docker 会话中 fork；
- stdio MCP 通过同一个活动 Docker Session 启动；远程 HTTP/SSE MCP 在控制面运行并遵守网络策略；

## 8. 容器生命周期

daemon 持有唯一的内存 `ExecutionEnvironmentManager`。workspace owner 和 config hash 决定环境复用；config hash 不进入容器名。同 owner 有活动 lease 时若请求另一份配置，会返回 `environment_config_in_use`，不会启动第二个版本。

Desktop 管理的容器记录 installation、workspace owner、config hash、environment ID 和创建者 daemon 身份。容器内 exec 记录当前 daemon owner ID + generation、environment ID、execution kind 和 execution ID。正常关闭后 generation 可能重新从 1 开始，因此判断旧 exec 必须同时比较 owner ID 和 generation。

底层 Docker 后端也保留 CLI 的 workspace 复用容器：容器名只由 owner/workspace 决定，不包含 config hash。发现同名、可确认属于当前 installation/workspace owner 且 hash 过期的容器时，删除旧容器并按最新配置重建，不同时保留多个版本。缺少新身份 label 或无法确认 owner 的同名容器不会被自动删除，启动会 fail-closed。

Settings 使用同目录临时文件和原子 rename。rename 前崩溃时保留完整旧配置，rename 后崩溃时读取完整新配置；系统不另存切换状态或旧环境版本。

## 9. Desktop 与 CLI 的边界

Desktop `desktop_managed`：

- 只支持 local/docker；
- Docker 强制 `failIfUnavailable=true`；
- 拒绝 SRT 和 `extraMounts`；
- 不读取旧字段或旧格式版本。

CLI `cli_advanced`：

- 继续支持现有 SRT 和原始 Docker 高级配置；
- 仍走旧兼容执行路径，不能被 Desktop 的安全承诺代替。

## 10. 验证

真实 Docker E2E 位于：

```bash
pnpm --filter @openharness/sandbox e2e:docker
pnpm --filter @openharness/tools e2e:docker
pnpm --filter @openharness/terminal-node e2e:docker
```

覆盖 `/workspace` cwd、容器内 Shell、五个文件工具、工作区/用户 Skills 双向写入、未挂载路径拒绝、容器复用与最新配置替换、网络隔离和进程清理。PTY E2E 额外覆盖 `tty -s`、输入输出、resize、Ctrl-C、EOF、terminate 和关闭单个终端后 Agent lease 继续工作。Sandbox orphan E2E 覆盖旧临时容器删除、复用容器旧 exec 清理、当前 exec 保留和其他 installation 不误删。外网 bridge 用例仅在显式设置 `OPENHARNESS_E2E_DOCKER_NETWORK=1` 时运行。

## 11. 交互终端调用链

```text
TerminalCreateRequest(scope=session|project, runtime=local|sandbox)
  → DaemonTerminalService 从 Store 解析可信 cwd
  ├─ local   → host EnvironmentPtyTarget → node-pty
  └─ sandbox → Manager.acquire(terminal lease)
                 → environment.terminal.prepare()
                 → docker exec -it -w /workspace
                 → node-pty
```

Docker PTY 用 `OPENHARNESS_PTY_ID` 标识容器内 shell。resize 通过该 ID 找到目标 PTY 并设置 `stty rows/cols`；Ctrl-C 和 EOF 写入控制字符；terminate 只停止该终端的容器进程并释放它自己的 lease。

Terminal HTTP 新客户端发送显式判别 scope。旧请求只有 projectId 或 sessionId 时仍可解析；两者同时出现时，服务验证 Session 确实属于 Project 且 cwd 一致。Renderer 传入的 cwd 不能覆盖 Store 中的可信 cwd。

## 12. 后续阶段

第三期 3A 已完成，继续采用“保存后重启生效”。3B–3D 分别处理 Native Plugin 环境化、Skill/工作区生命周期和具备真实 Docker daemon 的跨平台 CI。无需重启的热切换暂缓并单独评估；系统仍不支持旧环境并存或持久 lease。
