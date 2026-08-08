# Swarm File Infrastructure Design Archive

> Status: historical archive.
>
> This document used to describe the subprocess-era file mailbox and permission-sync plan. That path is no longer the current Agent execution path. Current Agent execution goes through `ToolRuntimeHost.spawnChildAgent()` and `DaemonChildAgentHost`.

## Current Reality

- Agent tool child execution: [`agent-child-session-flow.md`](./agent-child-session-flow.md)
- Runtime host boundary: [`runtime-host-port-design.md`](./runtime-host-port-design.md)
- Tool permission flow: [`permission-flow.md`](./permission-flow.md)
- Worktree isolation: [`swarm-worktree-design.md`](./swarm-worktree-design.md)

## What Remains In Code

`@openharness/swarm` still contains reusable file-based infrastructure:

- `lockfile.ts`
- `mailbox.ts`
- `permission-sync.ts`
- `team-lifecycle.ts`
- `worktree.ts`

The old runtime backend pieces are removed from the public surface:

- `ChildSessionBackend`
- `BackendRegistry`
- `getBackendRegistry`
- `TeammateSpawnConfig`
- `SwarmBackend`

## Historical Note

The old design treated workers as subprocess teammates that coordinated through filesystem mailboxes and file-backed permission requests. That was useful as a migration stepping stone, but daemon mode now centralizes child-agent lifecycle, permissions, durable task projection, and SSE through the runtime host boundary.
