# Sandbox Runtime 调用链

Sandbox 有两条后端：

- **`srt`**：用 Anthropic Sandbox Runtime（`@anthropic-ai/sandbox-runtime`）把**每条** shell 命令包一层。
- **`docker`**：启动一个长驻容器，后续 shell 用 `docker exec` 在容器内跑。

默认关闭。开启且未指定 backend 时，默认是 **`srt`**。

设计细节见 [`sandbox-runtime-design.md`](./sandbox-runtime-design.md)。

## 核心模型：启动选后端 + 执行时包装

分两阶段：

1. **启动**：按配置/环境选后端并准备（srt 只检查可用性；docker 起容器）。
2. **执行**：Bash 走对应后端；文件工具仍在宿主进程，但过路径校验。

```text
┌─ 启动（一次）─────────────────────────────────────────┐
│ loadSettings → bootstrap → startSandboxRuntime         │
│   srt:  检查环境，记下 status=active                   │
│   docker: 检查环境 + 起容器 + setActiveSandboxSession  │
└────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─ 每轮工具调用 ─────────────────────────────────────────┐
│ Bash  → createShellProcess                             │
│           srt    → wrapCommandForSrt → spawn srt -c …  │
│           docker → docker exec … /bin/sh -c …          │
│           off    → 宿主 shell                          │
│ 文件工具 → sandboxPathError → 宿主读写 + 路径校验      │
└────────────────────────────────────────────────────────┘
```

## 涉及的模块

| 组件 | 文件 | 职责 |
|------|------|------|
| 配置归一化 | `packages/sandbox/src/config.ts` | `normalizeSandboxConfig`：默认值、`runtime`→`backend` 别名 |
| 可用性 | `packages/sandbox/src/availability.ts` | 平台 / `srt` / `bwrap` / `sandbox-exec` / Docker CLI·daemon |
| 生命周期 | `packages/sandbox/src/lifecycle.ts` | `startSandboxRuntime`：按 backend 分支启动或 inert |
| SRT 包装 | `packages/sandbox/src/srt-adapter.ts` | 写临时 settings，拼 `srt --settings … -c …` |
| Docker 后端 | `packages/sandbox/src/docker-backend.ts` | `DockerSandboxSession`：`docker run` / `exec` / stop；Win 挂载 `/workspace` |
| Session | `packages/sandbox/src/session.ts` | 进程内唯一 active sandbox session |
| Shell helper | `packages/sandbox/src/shell.ts` | `createShellProcess`；宿主 `resolveShellArgv`（探测缓存）；容器 `resolveContainerShellArgv` |
| 路径校验 | `packages/sandbox/src/path-validator.ts` | 文件工具路径是否在 sandbox root / allow 列表 |
| CLI 挂载 | `apps/cli/src/runtime.ts` | `attachSandboxRuntime`：bootstrap 后启动，docker 时注册 cleanup |
| Bash | `packages/tools/src/shell/bash.ts` | timeout / 输出截断；spawn 走 `createShellProcess` |
| 文件守卫 | `packages/tools/src/file/sandbox-guard.ts` | Read/Write/Edit/Glob/Grep 调 `validateSandboxPath` |
| Settings | `packages/core/src/config/settings.ts` | env 覆盖 `OPENHARNESS_SANDBOX_*` |

## A. 启动阶段

```text
apps/cli/src/commands/main.ts
  mainAction()
    └─ loadSettings(overrides)
         └─ mergeSandboxConfig / buildSandboxEnvOverrides

    └─ bootstrap(settings)                         # apps/cli/src/runtime.ts
         └─ 组装 QueryEngine / ToolRegistry / …
         └─ RuntimeBuilder.build(settings)
         └─ attachSandboxRuntime(bundle, cwd)
              └─ startSandboxRuntime({ settings, cwd, sessionId })
                   # packages/sandbox/src/lifecycle.ts
```

常用环境变量：

```bash
OPENHARNESS_SANDBOX_ENABLED=true
OPENHARNESS_SANDBOX_BACKEND=docker          # 或 srt
OPENHARNESS_SANDBOX_FAIL_IF_UNAVAILABLE=true
OPENHARNESS_SANDBOX_NETWORK_MODE=bridge     # none | bridge | host | proxy
OPENHARNESS_SANDBOX_DOCKER_IMAGE=node:22-bookworm
OPENHARNESS_SANDBOX_DOCKER_DNS=1.1.1.1,8.8.8.8
OPENHARNESS_SANDBOX_HTTP_PROXY=http://host.docker.internal:7890
OPENHARNESS_SANDBOX_HTTPS_PROXY=http://host.docker.internal:7890
OPENHARNESS_SANDBOX_NO_PROXY=localhost,127.0.0.1
```

`startSandboxRuntime` 分支：

```text
normalizeSandboxConfig(settings.sandbox)
  │
  ├─ enabled=false
  │    → inertRuntime(state=off)                   # 不包装、不启容器
  │
  ├─ backend === "srt"（默认）
  │    └─ getSrtAvailability()
  │         检测：平台？srt CLI？Linux/WSL 要 bwrap？macOS 要 sandbox-exec？
  │         可用 → inertRuntime(state=active)      # 不启长驻进程
  │         不可用 + failIfUnavailable → 抛错
  │         不可用 + 可降级 → inertRuntime(unavailable)
  │
  └─ backend === "docker"
       └─ getDockerAvailability()
            检测：平台 / docker CLI / daemon；host@macOS 等限制
       └─ new DockerSandboxSession().start()
            docker run -d --rm … image tail -f /dev/null
       └─ setActiveSandboxSession(session)
       └─ CLI 仅在 docker active 时注册 cleanup（进程 exit → stop 容器）
```

要点：

- `srt` 启动时**只检查可用性**，真正包装发生在每次 shell。
- `docker` 启动时**起长驻容器**，后续 shell 用 `docker exec`。
- 未指定 `backend` 时默认 `"srt"`；旧字段 `runtime: "docker"|"srt"` 会映射到 `backend`。
- `failIfUnavailable=true` 时启动失败即中断；否则记 `unavailable`，继续无沙箱跑。

## B. 执行阶段

### B1. Shell（Bash）

```text
模型调 Bash
  └─ QueryEngine.executeTools()
       └─ bashTool.execute()                       # packages/tools/src/shell/bash.ts
            └─ createShellProcess(command, { cwd }) # packages/sandbox/src/shell.ts
                 │
                 ├─ sandbox.enabled=false
                 │    → spawnHost(resolveShellArgv)   # 宿主 shell；探测结果进程内缓存
                 │
                 ├─ backend === "docker"
                 │    └─ argv = resolveContainerShellArgv  # 固定 ["/bin/sh","-c",cmd]
                 │         getActiveSandboxSession()
                 │         active → session.execCommand(argv)  # docker exec …
                 │         否则 → fail closed 抛错，或降级宿主 resolveShellArgv
                 │
                 └─ backend === "srt"
                      └─ getSrtAvailability()
                           不可用 → 降级或抛错
                           可用 → wrapCommandForSrt(resolveShellArgv)
                                    写临时 settings.json（filesystem / network）
                                    argv = [srt, --settings, path, -c, shellJoin(原argv)]
                                  → spawnHost(wrapped.argv)
                                  → close/error 时 cleanup 临时目录
```

### B2. 文件工具（宿主执行 + 路径边界）

MVP 不做文件工具容器化：`Read` / `Write` / `Edit` / `Glob` / `Grep` 仍在宿主进程读写，sandbox 开启时必须过路径校验。

```text
Bash              → docker exec 或 srt 包装
Read/Write/Edit   → 宿主进程 + path guard
Glob/Grep         → 宿主进程 + path guard
```

```text
文件工具
  └─ sandboxPathError(path, cwd, operation)        # sandbox-guard.ts
       └─ settings.sandbox.enabled !== true → 放行
       └─ validateSandboxPath(...)
            deny 优先于 allow；拒绝 .. / 越界 symlink；
            默认只允许 sandboxRoot（cwd）及 allow / extraAllowedRoots
```

## C. Docker 后端细节

长驻空闲容器大致为：

```text
docker run -d --rm \
  --name openharness-sandbox-... \
  --network <none|bridge|host> \
  --dns <server> \                 # 可选，来自 OPENHARNESS_SANDBOX_DOCKER_DNS
  -v <host-workspace>:<container-workspace> \
  -w <container-workspace> \
  <image> tail -f /dev/null
```

路径映射：

| 平台 | 容器内工作目录 |
|------|----------------|
| Linux / WSL / macOS | 与宿主绝对路径相同（`cwd:cwd`） |
| Windows Docker Desktop | 宿主工作区挂到 **`/workspace`** |

每条 shell：

```text
docker exec -w <container-workspace> <container> /bin/sh -c "<command>"
```

网络注意：

- `bridge` 只表示允许 Docker 网络，**不保证** DNS 或外网一定通。
- Windows Docker Desktop 上 DNS 失败时可用 `OPENHARNESS_SANDBOX_DOCKER_DNS`。
- 访问本机代理常用 `host.docker.internal`（配合 `OPENHARNESS_SANDBOX_HTTP(S)_PROXY`）。
- `proxy` 网络模式当前是 bridge + proxy env；需要配置 `OPENHARNESS_SANDBOX_HTTP_PROXY` 或 `OPENHARNESS_SANDBOX_HTTPS_PROXY`。
- macOS 上 `host` 网络直接拒绝。

## D. SRT 后端细节

SRT **不**起长驻会话。每条 shell：

```text
srt --settings <temp-settings.json> -c "<quoted shell command>"
```

临时 settings 由 OpenHarness sandbox 的 filesystem / network 配置映射而来；进程结束后删掉临时目录。

## E. 何时用 Docker vs SRT

| 条件 | 结果 |
|------|------|
| `sandbox.enabled=false`（默认） | 全部宿主执行，无包装 |
| `enabled=true`，未指定 backend | **srt** |
| `backend="srt"` 或 `runtime="srt"` | srt CLI 包每条 shell |
| `backend="docker"` 或 `runtime="docker"` | 启容器 + docker exec |
| srt/docker 不可用且 `failIfUnavailable=false` | 降级宿主执行 |
| 不可用且 `failIfUnavailable=true` | 启动或执行时报错 |
| native Windows 上 srt | MVP 不支持；设计上走 WSL |
| Windows + Docker Desktop | 可用 docker；容器 cwd 为 `/workspace` |

## F. 状态展示

`/status` 会报告 sandbox 状态，例如：

```text
Sandbox:       active (docker)
Network:       bridge
Container:     openharness-sandbox-...
Container cwd: /workspace
DNS:           1.1.1.1, 8.8.8.8
Proxy:         configured
```

代理只显示是否已配置，**不打印**具体 proxy URL。
