# @openharness/sandbox

Sandbox runtime helpers for OpenHarness.

Current MVP:

- `srt` backend wraps shell commands with Anthropic Sandbox Runtime.
- `docker` backend starts a long-lived container and runs shell commands with `docker exec`.
- Docker `proxy` network mode uses Docker bridge networking and injects configured proxy env.
- Docker images are checked before startup; missing images can be built from the bundled Dockerfile when `autoBuildImage` is enabled.
- File tools remain host-side and use path validation when sandboxing is enabled.
- `SandboxAdapter` is a legacy compatibility facade over the shared runtime path.

Known gaps:

- Docker/SRT E2E tests are optional and environment-gated; CI wiring is still pending.

## CLI

```bash
ohs sandbox on
ohs sandbox on --net none
ohs sandbox on --backend srt
ohs sandbox on --net proxy --proxy http://host.docker.internal:7890
ohs sandbox off
ohs sandbox status
ohs sandbox doctor
```

`ohs sandbox on` persists Docker sandbox settings with `network=bridge` by default. Restart the CLI/TUI
after changing sandbox settings.

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
