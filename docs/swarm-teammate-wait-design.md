# Swarm Teammate Wait Design Archive

> Status: historical archive.
>
> `TaskWait` remains a current tool, but the old BackendHost/OHJSON `swarm_status` channel and subprocess teammate flow are no longer current.

## Current Reality

For child-agent work, the user-visible task is a durable projection:

```text
DaemonChildAgentHost
  -> SessionTaskBridge.registerSessionTask()
  -> child run executes
  -> SessionTaskBridge.completeSessionTask()
  -> TaskWait reads the task projection
```

Current references:

- [`agent-child-session-flow.md`](./agent-child-session-flow.md)
- [`daemon-runtime-flow-map.md`](./daemon-runtime-flow-map.md)
- [`daemon-runtime-code-guide.md`](./daemon-runtime-code-guide.md)

## Historical Note

This document originally described adding wait/join semantics to subprocess teammates. The product-level idea survived as `TaskWait`; the transport and status channel did not.
