# Swarm Task Worker Design Archive

> Status: historical archive.
>
> The `ohs --task-worker` / subprocess worker protocol described here has been removed from the current runtime path. It is not a compatibility contract.

## Current Replacement

Current child-agent execution is:

```text
Agent tool / Workflow
  -> ToolRuntimeHost.spawnChildAgent()
  -> DaemonRuntimeHostPort
  -> DaemonChildAgentHost
  -> child session + parent task projection
```

Read the current flow here:

- [`agent-child-session-flow.md`](./agent-child-session-flow.md)
- [`daemon-runtime-code-guide.md`](./daemon-runtime-code-guide.md)
- [`runtime-host-port-design.md`](./runtime-host-port-design.md)

## Historical Note

The old worker design used restart-style subprocess turns and session snapshots to simulate multi-turn teammates. That approach was superseded by daemon-owned child sessions, where the child run goes through the same `SessionRunEngine`, `SessionStore`, permission broker, and SSE event stream as any other daemon session.
