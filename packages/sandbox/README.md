# @openharness/sandbox

Sandbox runtime helpers for OpenHarness.

Current MVP:

- `srt` backend wraps shell commands with Anthropic Sandbox Runtime.
- `docker` backend starts a long-lived container and runs shell commands with `docker exec`.
- Docker `proxy` network mode uses Docker bridge networking and injects configured proxy env.
- Docker images are checked before startup; missing images can be built from the bundled Dockerfile when `autoBuildImage` is enabled.
- `ohs sandbox on` enables a project-local reusable Docker container by default. The container is named from the
  workspace path and survives CLI/TUI exits until `ohs sandbox clean` removes it.
- File tools remain host-side and use path validation when sandboxing is enabled.
- `SandboxAdapter` is a legacy compatibility facade over the shared runtime path.

Known gaps:

- Docker/SRT E2E tests are optional and environment-gated; CI wiring is still pending.

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

`ohs sandbox on` persists project-local Docker sandbox settings with `network=bridge` and `reuseContainer=true`
by default. Restart the CLI/TUI after changing sandbox settings.

## Docker Lifecycle

Default project mode:

1. `ohs sandbox on` writes `.openharness/settings.json` in the current workspace.
2. On CLI/TUI startup, OpenHarness checks Docker availability and the configured image.
3. If the image is missing and `autoBuildImage=true`, OpenHarness builds it from `packages/sandbox/Dockerfile`.
4. The reusable container name is derived from the workspace path, for example
   `openharness-sandbox-my-project-<hash>`.
5. If that container already exists, OpenHarness starts it if needed and runs shell commands with `docker exec`.
6. On CLI/TUI exit, reusable containers are left in place for the next run.
7. `ohs sandbox clean` removes the reusable container for the current workspace.

With `ohs sandbox on --no-reuse`, each OpenHarness session creates a session-named Docker container with `--rm`
and stops it during process cleanup.

## Optional E2E

```bash
pnpm --filter @openharness/sandbox e2e:docker
pnpm --filter @openharness/sandbox e2e:srt
pnpm --filter @openharness/sandbox e2e
```

Docker E2E uses `node:22-bookworm` by default and skips when Docker or that image is unavailable. Set
`OPENHARNESS_E2E_DOCKER_IMAGE` to test another local image.

Docker bridge network E2E is opt-in because network availability is host-dependent:

```bash
OPENHARNESS_E2E_DOCKER_NETWORK=1 pnpm --filter @openharness/sandbox e2e:docker
```

SRT E2E skips when `srt` or its platform dependencies are unavailable.
