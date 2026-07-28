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

- Real Docker/SRT end-to-end tests are manual; unit tests cover argv, config, lifecycle decisions, and path guards.
