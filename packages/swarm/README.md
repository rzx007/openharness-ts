# @openharness/swarm

Reusable filesystem-based swarm infrastructure.

This package no longer provides the runtime child-agent backend. Current Agent and Workflow execution goes through the framework-owned `AgentChildManager`; daemon hosting adds durable child session/task/run projection through `AgentChildProjection`.

## Public Surface

- Team and mailbox helpers
- File-backed permission synchronization helpers
- Team lifecycle helpers
- Worktree helpers

Removed from the public surface:

- `ChildSessionBackend`
- `BackendRegistry`
- `getBackendRegistry`
- `TeammateSpawnConfig`
- `SwarmBackend`

## Tests

```bash
pnpm --filter @openharness/swarm test
```
