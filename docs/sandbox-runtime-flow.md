# Agent 运行环境与 Docker 调用链

> 状态：第一期实现说明。Desktop 使用统一 `ExecutionEnvironment`；CLI 高级模式继续保留原有 SRT/Docker 能力。

## 1. 两个设置互不混用

- **智能体运行环境**决定 Agent 的命令、脚本和文件工具在哪里执行。Desktop 当前支持“本机”和“Docker 沙箱”。
- **集成终端 Shell**只决定用户手动打开的本机终端使用哪个 Shell。第一期集成终端不会进入 Docker。

因此，选择 Docker 后：

- Agent 看到 Linux、`/bin/sh` 和 `/workspace`；
- 用户手动打开的集成终端仍在宿主机运行，界面明确标为“本机终端”；
- `TerminalOpen` 和 Native Plugin Tool 在 Docker Agent 中不可用；
- 设置保存后需要重启 OpenHarness，新环境不会伪装成立即生效。

## 2. Desktop 启动顺序

```text
Desktop 启动内置 daemon
  → executionSurface = desktop_managed
  → daemon 按 Session.cwd 读取 Settings
  → resolveExecutionEnvironmentConfig()
       local  → 本机环境
       docker → 严格 Docker 环境
       srt / extraMounts → 拒绝，不降级
  → createWorkspaceBinding()
       hostRoot      = Session.cwd
       executionRoot = local ? Session.cwd : /workspace
  → createExecutionEnvironment()
       preflight → 创建挂载 → 启动容器 → probe → ready
  → 创建 Tool Registry、PermissionChecker 和 system prompt
  → 向模型开放与当前环境兼容的工具
```

项目外会话也走同一条流程。它已有一个位于“文档/OpenHarness/日期/xN”的受管 cwd，该目录直接成为 `hostRoot`，不需要 `projectId` 或另一套 Projectless Runtime。

Docker 不可用、配置不合法或容器启动失败时，环境创建失败，Agent 不会退回宿主执行。

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

第一期安全限制：

- Native Plugin Tool Host 不在 Docker 会话中 fork；
- Agent `TerminalOpen` 不注册；
- stdio MCP 通过同一个活动 Docker Session 启动；远程 HTTP/SSE MCP 在控制面运行并遵守网络策略；
- 用户集成终端固定 `runtime: local`。

## 8. 容器生命周期

Desktop 受管环境按 Session 启动临时容器，关闭 Agent Runtime 时释放。受管挂载会进入配置 hash。

底层 Docker 后端也保留 CLI 的 workspace 复用容器：容器名只由 owner/workspace 决定，不包含配置 hash。发现同名、可确认属于 OpenHarness 且 hash 过期的容器时，删除旧容器并按最新配置重建，不同时保留多个版本。无法确认 owner 的同名容器不会被删除，启动会 fail-closed。

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
```

覆盖 `/workspace` cwd、容器内 Shell、五个文件工具、工作区/用户 Skills 双向写入、未挂载路径拒绝、容器复用与最新配置替换、网络隔离和进程清理。外网 bridge 用例仅在显式设置 `OPENHARNESS_E2E_DOCKER_NETWORK=1` 时运行。

## 11. 后续阶段

第二期实现 Docker PTY、Agent Terminal 与默认用户终端跟随 Agent 环境、session/project 终端作用域和共享容器 lease。

第三期实现运行中 draining/switching、持久化切换恢复、孤儿清理和更完整的热刷新。仍只保留单一最新容器版本，不支持旧环境并存。
