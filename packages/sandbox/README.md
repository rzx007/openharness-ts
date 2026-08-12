# @openharness/sandbox

OpenHarness 的 sandbox runtime 辅助层。

当前 MVP：

- **`srt` 后端**：用 Anthropic Sandbox Runtime 包装每条 shell 命令。
- **`docker` 后端**：启动长驻容器，shell 命令通过 `docker exec` 执行；容器带 Docker `--init`，用于回收被停止命令留下的子进程。
- Docker **`proxy` 网络模式**：走 Docker bridge，并注入配置的代理环境变量。
- 启动前检查 Docker 镜像；镜像缺失且开启 `autoBuildImage` 时，可用内置 Dockerfile 构建。
- `ohs sandbox on` 默认启用**项目本地、可复用**的 Docker 容器。容器名由工作区路径派生，
  CLI/TUI 退出后仍保留，直到 `ohs sandbox clean` 删除。
- 取消或超时不会只关掉宿主上的 `docker exec`，还会停止容器内命令及其启动的子进程。
- 自定义 Docker 镜像必须提供 `node`、`rg`、`setsid`、`sleep` 和 `/bin/kill`，否则 shell 或文件工具可能无法运行。
- `Read` / `Write` / `Edit` / `Glob` / `Grep` 先做路径校验；Docker active 时真实读写和搜索在容器内执行。`Read` / `Write` / `Edit` 通过容器内一次性 Node helper 执行，工具层用 stdin 传 `{ op, path, content }` 这类请求。
- MCP stdio server 通过 `createProcess` 启动，和普通 Agent 工作负载走同一套 sandbox 规则。
- `SandboxAdapter` 是兼容旧接口的门面，底层走统一 runtime 路径。

已知缺口与后续：

- Docker/SRT E2E 仍按环境可选；Docker daemon 不可用时会跳过。Docker 默认 E2E、文件工具 E2E、MCP stdio E2E 已有真实 Docker 覆盖，CI 固定运行环境还待接线。
- 主 daemon 托管的 Cron 已通过自己的 `cwd + cron:<jobId>` 范围接入 Sandbox。
- `network=none` 已真实隔离网络；域名 allow/deny 还没有真正拦截，只会在 bridge/host 模式下标记 degraded。后续要补真实网络策略。
- 文件 helper 目前是 `node -e "<内嵌脚本>" + stdin JSON`。后续可以改成镜像内固定命令，例如 `oh-file-helper`，让协议更清楚，也方便版本管理。

## CLI

```bash
ohs sandbox on
ohs sandbox on --net none
ohs sandbox on --no-reuse
ohs sandbox on --global
ohs sandbox on --backend srt
ohs sandbox on --net proxy --proxy http://host.docker.internal:7890
ohs sandbox off
ohs sandbox clean
ohs sandbox status
ohs sandbox doctor
```

`ohs sandbox on` 默认把**项目本地** Docker sandbox 配置写入 settings（`network=bridge`、
`reuseContainer=true`）。修改 sandbox 设置后需重启 CLI/TUI 才会生效。

## Docker 生命周期

默认项目模式：

1. `ohs sandbox on` 写入当前工作区的 `.openharness/settings.json`。
2. CLI/TUI 启动时检查 Docker 可用性与配置镜像。
3. 镜像缺失且 `autoBuildImage=true` 时，从 `packages/sandbox/Dockerfile` 构建。
4. 可复用容器名由工作区路径派生，例如 `openharness-sandbox-my-project-<hash>`。
5. 若容器已存在：需要时先 start，再通过 `docker exec` 跑 shell。
6. CLI/TUI 退出时先停止仍在容器里运行的命令，但**不删除**可复用容器，留给下次使用。
7. `ohs sandbox clean` 删除当前工作区对应的可复用容器。

使用 `ohs sandbox on --no-reuse` 时，每次 OpenHarness 会话创建带 `--rm` 的会话级容器，
并在进程清理时 stop。

## 可选 E2E

```bash
pnpm --filter @openharness/sandbox e2e:docker
pnpm --filter @openharness/sandbox e2e:srt
pnpm --filter @openharness/sandbox e2e
pnpm --filter @openharness/tools e2e:docker
pnpm --filter @openharness/mcp e2e:docker
```

Docker E2E 默认用 `openharness-sandbox:latest`；镜像缺失且未显式指定镜像时，会尝试用内置 Dockerfile 构建。可用
`OPENHARNESS_E2E_DOCKER_IMAGE` 指定本地其他镜像；显式指定后，镜像不存在会跳过。

文件工具 E2E 默认用 `openharness-sandbox:latest`，因为需要 `node` 和 `rg`；缺失时会尝试用内置 Dockerfile 构建。可用 `OPENHARNESS_E2E_DOCKER_FILE_IMAGE` 指定已有镜像。

MCP stdio E2E 默认用 `openharness-sandbox:latest`；缺失时允许用内置 Dockerfile 构建。可用 `OPENHARNESS_E2E_DOCKER_MCP_IMAGE` 指定已有镜像。

Docker bridge 网络 E2E 为可选（依赖本机网络）：

```bash
OPENHARNESS_E2E_DOCKER_NETWORK=1 pnpm --filter @openharness/sandbox e2e:docker
```

`srt` 或其平台依赖不可用时，SRT E2E 会跳过。
