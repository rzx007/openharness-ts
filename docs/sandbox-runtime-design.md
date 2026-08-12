# 设计：Sandbox runtime 接入

> 状态（2026-08-12）：Bash、TaskManager、autodream、command hooks、Cron/RemoteTrigger 和 LSP ripgrep 已统一经过 `@openharness/sandbox` 的 shell/argv process API。文件工具仍采用 host-guarded MVP；MCP stdio 与宿主基础设施不在该统一入口内。
>
> 当前完整调用链和下一步见 [`sandbox-runtime-flow.md`](./sandbox-runtime-flow.md)。

## 背景

Python 原版已经有两类 sandbox 后端：

- `srt`：通过 `@anthropic-ai/sandbox-runtime` 的 `srt --settings <file> -c <command>` 包装 shell 命令。
- `docker`：启动一个长驻容器，后续 shell 命令通过 `docker exec` 在容器内运行。

TS 版当前已经有可用的 sandbox MVP：CLI 启动 runtime，`Bash` 通过统一 shell helper 进入 `srt` 或 Docker，文件工具仍在宿主进程执行但受 sandbox 路径边界约束。本文保留实现边界和后续收口事项。

## 目标

- 给 TS 版增加可用的 sandbox runtime 层，覆盖 `Bash` 和其他共享 shell helper 的调用。
- 支持 `srt` 和 `docker` 两个后端，默认关闭。
- Docker 后端支持网络策略配置，不再只能硬编码断网。
- Docker active 时，`Read` / `Write` / `Edit` / `Glob` / `Grep` 等宿主文件工具必须被 sandbox 边界约束。
- sandbox 不可用时可配置为降级运行或 fail closed。

## 非目标

- MVP 不做所有工具完全容器化：`Bash` 走 sandbox，文件工具仍在宿主进程执行并通过 path guard 限界。
- MVP 不承诺 Docker `bridge`/`host` 的域名级 allow/deny 过滤；严格域名策略只能由可执行该策略的后端承诺。
- MVP 的 `srt` 不支持 native Windows；Docker backend 支持 Windows Docker Desktop，容器内工作目录映射为 `/workspace`。Windows 用户也可以继续通过 WSL 使用。
- MVP 不改变现有 permission 模型：permission 决定工具是否允许调用，sandbox 是额外执行边界，不替代 permission。

## 人话模型

Docker sandbox 启用后：

- `Bash` 在容器里跑。
- 项目目录 bind mount 到容器里，所以 shell 能读写项目文件。
- `Read` / `Write` / `Edit` 这类内置文件工具仍由 TS 主进程在宿主机读写。
- 这些宿主文件工具必须先做路径校验，只允许访问 sandbox root 及显式 allow 的目录。

也就是说，MVP 是：

```text
shell 命令：容器内执行
项目目录：宿主和容器共享
内置文件工具：宿主执行 + sandbox 路径边界检查
```

## 配置

扩展 `Settings.sandbox`：

```ts
export interface SandboxConfig {
  enabled: boolean;
  backend?: "srt" | "docker";
  failIfUnavailable?: boolean;
  enabledPlatforms?: Array<"linux" | "wsl" | "macos">;
  filesystem?: SandboxFilesystemConfig;
  network?: SandboxNetworkConfig;
  docker?: DockerSandboxConfig;
  srt?: SrtSandboxConfig;
}

export interface SandboxFilesystemConfig {
  allowRead?: string[];
  denyRead?: string[];
  allowWrite?: string[];
  denyWrite?: string[];
  extraAllowedRoots?: string[];
}

export interface SandboxNetworkConfig {
  mode?: "none" | "bridge" | "host" | "proxy";
  allowedDomains?: string[];
  deniedDomains?: string[];
  strictDomainPolicy?: boolean;
}

export interface DockerSandboxConfig {
  image?: string;
  autoBuildImage?: boolean;
  cpuLimit?: number;
  memoryLimit?: string;
  extraMounts?: string[];
  extraEnv?: Record<string, string>;
  containerNamePrefix?: string;
}

export interface SrtSandboxConfig {
  runtimeCommand?: string;
}
```

默认值：

```json
{
  "sandbox": {
    "enabled": false,
    "backend": "srt",
    "failIfUnavailable": false,
    "filesystem": {
      "allowRead": ["."],
      "allowWrite": ["."],
      "denyRead": [],
      "denyWrite": []
    },
    "network": {
      "mode": "none",
      "allowedDomains": [],
      "deniedDomains": [],
      "strictDomainPolicy": false
    },
    "docker": {
      "image": "openharness-sandbox:latest",
      "autoBuildImage": true,
      "cpuLimit": 0,
      "memoryLimit": "",
      "extraMounts": [],
      "extraEnv": {}
    }
  }
}
```

环境变量覆盖：

- `OPENHARNESS_SANDBOX_ENABLED=true`
- `OPENHARNESS_SANDBOX_BACKEND=docker`
- `OPENHARNESS_SANDBOX_FAIL_IF_UNAVAILABLE=true`
- `OPENHARNESS_SANDBOX_NETWORK_MODE=bridge`
- `OPENHARNESS_SANDBOX_DOCKER_IMAGE=openharness-sandbox:latest`
- `OPENHARNESS_SANDBOX_DOCKER_DNS=1.1.1.1,8.8.8.8`
- `OPENHARNESS_SANDBOX_HTTP_PROXY=http://host.docker.internal:7890`
- `OPENHARNESS_SANDBOX_HTTPS_PROXY=http://host.docker.internal:7890`
- `OPENHARNESS_SANDBOX_NO_PROXY=localhost,127.0.0.1`

## Docker 网络策略

### `none`

默认模式。容器启动参数：

```text
--network none
```

行为：

- 容器不能访问外网。
- 最安全，适合 `full_auto` 场景。
- `allowedDomains` / `deniedDomains` 无意义，启动时可提示被忽略。

### `bridge`

容器启动参数：

```text
--network bridge
```

行为：

- 容器可通过 Docker 默认 bridge 访问网络。
- 不做域名级限制。
- 如果配置了 `allowedDomains` / `deniedDomains`：
  - `strictDomainPolicy=false`：允许启动，但输出 warning。
  - `strictDomainPolicy=true`：fail closed，拒绝启动。

### `host`

容器启动参数：

```text
--network host
```

行为：

- 仅 Linux/WSL 支持。macOS/Windows Docker Desktop 不保证语义一致。
- 网络能力最宽，不建议默认使用。
- 域名策略处理同 `bridge`。

### `proxy`

保留为增强模式，不作为 MVP 必选。

设计目标：

- 容器出网必须经过代理。
- `allowedDomains` / `deniedDomains` 由代理层执行。
- `strictDomainPolicy=true` 时，只有该模式或 `srt` 后端可以满足域名级策略。

实现选择：

- HTTP(S) proxy sidecar。
- DNS proxy + egress gateway。
- 后续也可以接公司内部代理或用户配置的 `HTTP_PROXY` / `HTTPS_PROXY`。

MVP 中 `network.mode="proxy"` 落地为 Docker `bridge` 网络 + 注入 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量；未配置代理时 fail closed。它不提供 Docker 侧域名级 allow/deny 过滤，严格域名策略仍需要后续 sidecar / DNS proxy / egress gateway。

## 运行时架构

新增或扩展 `@openharness/sandbox`：

```text
packages/sandbox/src/
  index.ts
  types.ts
  availability.ts
  path-validator.ts
  srt-adapter.ts
  docker-backend.ts
  session.ts
```

核心接口：

```ts
export interface SandboxSession {
  readonly backend: "srt" | "docker";
  readonly active: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  wrapCommand?(argv: string[]): Promise<{ argv: string[]; cleanup?: () => Promise<void> }>;
  execCommand?(
    argv: string[],
    options: ShellSpawnOptions
  ): Promise<ChildProcess>;
}
```

职责拆分：

- `availability.ts`：判断平台、依赖命令、Docker daemon、`srt`、`bwrap`、`sandbox-exec` 是否可用。
- `srt-adapter.ts`：写临时 settings JSON，返回包装后的 argv。
- `docker-backend.ts`：启动容器、停止容器、构造 `docker exec`。
- `session.ts`：维护当前进程唯一 active sandbox session。
- `path-validator.ts`：校验文件路径是否落在 sandbox root 或显式允许目录下。

## Shell 接线

抽出统一 shell helper，替代 `packages/tools/src/shell/bash.ts` 内部直接 `spawn`：

```ts
export async function createShellProcess(
  command: string,
  options: {
    cwd: string;
    settings: Settings;
    timeout?: number;
    env?: Record<string, string>;
    stdio?: StdioOptions;
  }
): Promise<ChildProcess>
```

执行顺序：

1. 解析 shell argv（docker 与宿主分开）：
   - 宿主：Windows 优先 `bash.exe -c`（非 login），否则 PowerShell/cmd；POSIX `/bin/sh -c`。探测结果进程内缓存。
   - Docker 容器内：固定 `/bin/sh -c`，不复用宿主（避免 Windows 上拼出 `bash.exe`）。
   - native Windows 上 `srt` 不可用；Docker backend 使用 Docker Desktop，并把容器内 cwd 映射为 `/workspace`。
2. 如果 `sandbox.enabled=false`，直接宿主执行。
3. 如果 `backend="docker"`：
   - active session 存在：走 `docker exec` + 容器 shell argv。
   - active session 不存在且 `failIfUnavailable=true`：报错。
   - active session 不存在且 `failIfUnavailable=false`：warning 后宿主执行。
4. 如果 `backend="srt"`：
   - 可用：用 `srt` 包装宿主 argv。
   - 不可用：按 `failIfUnavailable` 决定报错或降级。

`Bash` 工具只负责 timeout、输出截断、错误格式，不再直接管理 sandbox 细节。

## TUI / REPL 生命周期

在 runtime bootstrap 后启动 sandbox：

```text
loadSettings
create tool registry
create engine
if settings.sandbox.enabled:
  startSandboxSession(settings, sessionId, cwd)
```

退出或 runtime close 时停止：

```text
closeRuntime:
  stopSandboxSession()
  close MCP
  run hooks
```

注意：

- `sessionId` 用于 Docker container name，必须做安全字符归一。
- 进程异常退出时注册 `process.on("exit")` / `SIGINT` / `SIGTERM` 做 best-effort stop。
- 如果 stop 失败，不阻塞用户退出，但记录 warning。

## 文件工具边界

当 Docker sandbox active 时，宿主文件工具必须调用：

```ts
validateSandboxPath(path, {
  sandboxRoot: cwd,
  extraAllowedRoots: settings.sandbox.filesystem.extraAllowedRoots ?? [],
  operation: "read" | "write",
  filesystem: settings.sandbox.filesystem
})
```

规则：

- 路径先 `realpath` / canonicalize，避免 `..` 和 symlink 穿透。
- 默认只允许当前 `cwd` 下的路径。
- read 操作检查 `allowRead` / `denyRead`。
- write 操作检查 `allowWrite` / `denyWrite`。
- 系统保护路径仍然保留现有硬拒绝，比如 home、root、系统目录、`.git` 危险写入等。
- 校验失败时返回 tool error：`Sandbox: path is outside sandbox boundary`。

需要接线的工具：

- `Read`
- `Write`
- `Edit`
- `Glob`
- `Grep`
- 后续任何直接读写宿主 filesystem 的工具

## 文件工具容器化路线

当前 MVP 是“宿主文件工具 + sandbox path guard”。这不是最终形态，但它有两个好处：

- 保留现有 permission、diff approval、错误展示和测试行为。
- Docker / SRT 先把高风险 shell 执行边界收住，避免一次性重写所有文件工具。

对照上游和参考项目：

- Python OpenHarness：`Read` / `Write` / `Edit` 仍由宿主 `Path` 执行，只在 Docker active 时校验 sandbox path；`Glob` / `Grep` 在 `rg` 可用时通过 active Docker session `exec_command()` 跑进容器。
- Hermes-agent：文件工具统一封装为 `ShellFileOperations`，再交给当前 execution environment；environment 可以是 local、Docker、SSH、Modal、Daytona 等。这个模型更完整，但大量依赖 shell quoting、POSIX 工具、BOM/CRLF 保留、原子写、回读验证和 cwd tracking。

OpenHarness-ts 推荐吸收 Hermes 的抽象，而不是直接照搬 shell 实现：

```ts
export interface FileOperations {
  readText(path: string, options: ReadTextOptions): Promise<ReadTextResult>;
  writeText(path: string, content: string, options: WriteTextOptions): Promise<WriteTextResult>;
  stat(path: string): Promise<FileStatResult>;
  glob(pattern: string, options: GlobOptions): Promise<GlobResult>;
  grep(pattern: string, options: GrepOptions): Promise<GrepResult>;
}
```

实现分层：

```text
HostFileOperations
  使用宿主 fs / fast-glob / ripgrep，保持当前行为。

DockerFileOperations
  先做宿主 permission + validateSandboxPath。
  再把宿主路径翻译为容器路径。
  最后通过 active DockerSandboxSession.execCommand() 执行。

SrtFileOperations
  每次操作通过 srt 包装宿主命令。
  适合后续接入；MVP 可先不做。
```

Docker 路径翻译必须集中实现：

| 平台 | 宿主路径 | 容器路径 |
|------|----------|----------|
| Linux / WSL / macOS | `<cwd>/src/a.ts` | `<cwd>/src/a.ts` |
| Windows Docker Desktop | `D:\repo\src\a.ts` | `/workspace/src/a.ts` |

迁移顺序：

1. `Glob` / `Grep`：优先迁移。它们本来就常调用 `rg`，通过 `docker exec rg ...` 成本最低。
2. `Read`：容器内读取文本、二进制检测、分页；返回结构化结果。
3. `Write`：宿主生成 diff 和 approval，容器内原子写入。
4. `Edit`：容器读旧内容，宿主计算替换和 diff，批准后容器写回并回读验证。

如果 Docker shell 拼接开始变复杂，再引入容器内 helper：

```text
docker exec -i <container> node /opt/openharness/file-helper.mjs
stdin:  { "op": "readText", "path": "/workspace/src/a.ts", "offset": 0, "limit": 200 }
stdout: { "ok": true, "content": "...", "totalLines": 123, "truncated": false }
```

helper 的好处是避免把多行文本、特殊字符、JSON、Windows 路径、错误码都塞进 shell 字符串；缺点是镜像需要携带 helper，Dockerfile 和 autoBuildImage 要保证版本匹配。

建议新增配置：

```ts
export interface SandboxFileToolsConfig {
  mode?: "host-guarded" | "container-search" | "container";
}
```

语义：

- `host-guarded`：当前 MVP，文件工具宿主执行，必须 path guard。
- `container-search`：`Glob` / `Grep` 进容器，读写编辑仍宿主执行。
- `container`：读写搜索都进容器，宿主只负责 permission、path guard、diff approval 编排。

默认先保持 `host-guarded`。当 Docker E2E 覆盖 `Glob` / `Grep` 容器执行、Windows `/workspace` 映射、`Write` / `Edit` diff approval 和回读验证后，再考虑提升默认级别。

## Permission 与 sandbox 的关系

两者是叠加关系：

```text
PermissionChecker 先判断是否允许调用工具
Sandbox runtime 再限制工具实际能碰到的系统边界
```

建议：

- `--dangerously-skip-permissions` 或 `permission.mode=full_auto` 只在 `sandbox.enabled=true` 且 `failIfUnavailable=true` 时推荐。
- sandbox unavailable 且 `failIfUnavailable=false` 时，TUI 状态栏应显示 degraded。
- permission 批准不应绕过 sandbox path validator。
- sandbox path validator 拒绝不再弹 permission，因为这是硬边界。

## 平台支持

| 平台 | srt | Docker | 说明 |
|---|---|---|---|
| Linux | 支持 | 支持 | `srt` 需要 `bwrap` |
| WSL | 支持 | 支持 | 推荐 Windows 用户使用 |
| macOS | 支持 | 支持 | `srt` 需要 `sandbox-exec`；Docker `host` 网络语义有限 |
| native Windows | 不支持 | 支持 | `srt` 走 WSL；Docker Desktop 下容器 cwd 为 `/workspace` |

native Windows 的当前实现口径：
- `srt` 不支持 native Windows；需要使用 WSL。
- Docker backend 支持 Windows Docker Desktop。
- Windows 宿主工作区会挂载到 Linux 容器内的 `/workspace`。
- Docker bridge 不保证 DNS/代理天然可用；必要时配置 `OPENHARNESS_SANDBOX_DOCKER_DNS` 和 `OPENHARNESS_SANDBOX_HTTP(S)_PROXY`。

native Windows 不支持的原因：

- `srt` 依赖的 OS sandbox 能力不可直接映射。
- Docker Desktop 的路径、网络、PTY 行为和 POSIX 运行时差异较大。
- 当前 TS `Bash` 依赖 `bash.exe`，Windows 上经常是 Git Bash 或 WSL bash，语义不稳定。

## Docker 容器参数

启动 argv 形态：

```text
docker run -d --rm
  --name openharness-sandbox-<sessionId>
  --network <none|bridge|host>
  -v <cwd>:<cwd>
  -w <cwd>
  [--cpus N]
  [--memory LIMIT]
  [-v extraMount]
  [-e KEY=VALUE]
  <image>
  tail -f /dev/null
```

执行 argv 形态：

```text
docker exec
  -w <cwd>
  [-e KEY=VALUE]
  openharness-sandbox-<sessionId>
  <shell> -c <command>
```

## 错误与降级

`getSandboxAvailability(settings)` 返回：

```ts
type SandboxAvailability = {
  enabled: boolean;
  available: boolean;
  active: boolean;
  backend?: "srt" | "docker";
  reason?: string;
  degraded?: boolean;
}
```

典型错误：

- `sandbox is disabled`
- `srt sandbox is not supported on native Windows; use WSL`
- `Docker sandbox on native Windows requires Docker Desktop`
- `srt CLI not found`
- `bwrap is required on Linux/WSL`
- `docker CLI not found`
- `docker daemon is not running`
- `Docker strict domain policy is not supported for network mode bridge`

降级规则：

- `failIfUnavailable=true`：抛错，工具返回 error，runtime 可启动失败。
- `failIfUnavailable=false`：记录 warning，shell 回宿主执行，状态标记 degraded。

## 测试计划

单元测试：

- `availability`：
  - native Windows: `srt` unavailable, Docker Desktop available。
  - Linux 缺 `srt` / 缺 `bwrap`。
  - Docker CLI 缺失。
  - Docker daemon 不运行。
- `docker-backend`：
  - `network.mode=none` 生成 `--network none`。
  - `network.mode=bridge` 生成 `--network bridge`。
  - `strictDomainPolicy=true` + `bridge` + domains 时 fail closed。
  - CPU/memory/env/mount 参数正确。
  - `execCommand` 生成 `docker exec`。
- `srt-adapter`：
  - settings JSON 映射 filesystem/network。
  - argv 使用 `srt --settings <file> -c <escaped command>`。
  - cleanup 删除临时文件。
- `path-validator`：
  - 普通项目内路径允许。
  - `..` 穿透拒绝。
  - symlink 指向项目外拒绝。
  - `extraAllowedRoots` 允许。
  - deny 规则优先于 allow。
- `Bash`：
  - sandbox disabled 走宿主 spawn。
  - Docker active 走 session exec。
  - unavailable + fail closed 返回 error。
  - timeout 仍杀进程树或容器内命令。

E2E 测试（当前为可选脚本，CI 接入待补）：

- Docker sandbox 启动、执行 `echo`、停止。
- `network.mode=none` 下 `curl` 外网失败。
- `network.mode=bridge` 下 `curl` 外网成功。
- 容器内修改项目文件，宿主可见。
- Docker active 时 `Write` 项目外路径被拒绝。

## 实施步骤

1. 扩展 `Settings.sandbox` 类型和默认配置，补环境变量覆盖。
2. 实现 `packages/sandbox` 的 availability、path validator、srt adapter。
3. 实现 Docker session lifecycle 和 network mode 参数。
4. 抽出 shared shell helper，并让 `Bash` 走 helper。
5. 在 CLI/TUI runtime bootstrap 和 close 阶段启动/停止 sandbox session。
6. 给 `Read` / `Write` / `Edit` / `Glob` / `Grep` 接入 path validator。
7. 补单测和 Docker/SRT 可选 E2E 脚本。
8. 更新 README / `/doctor` / `/config show` 输出。

## 开放问题

- `proxy` 模式后续是否需要升级为严格域名代理（sidecar / DNS proxy / egress gateway），而不是当前的 bridge + proxy env MVP。
- `allowedDomains` 是否应在 `srt` 和 Docker 中使用同一配置，但按 backend 能力给出不同可用性。
- Docker image 自动构建后续是否要支持自定义 Dockerfile 路径、build args 和缓存策略。
- 是否需要把 hooks 也纳入同一个 shell helper。建议纳入，否则 hook 命令会绕过 sandbox。
- 是否给 TUI 状态栏增加 `sandbox: active/degraded/off`。
