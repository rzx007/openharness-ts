import type { AgentEvent } from "@openharness/core";
import { describe, expect, it, vi } from "vitest";

import { DaemonAgentEventProjector } from "../daemon-agent-event-projector.js";

describe("DaemonAgentEventProjector", () => {
  it("projects child and run facts without returning execution handles", async () => {
    const sessions = new Map<string, any>([[
      "parent",
      { id: "parent", cwd: "/repo", model: "gpt", metadata: { runtime: { model: "gpt" } } },
    ]]);
    const inputs = new Map<string, any>();
    const runs = new Map<string, any>();
    const tasks = new Map<string, any>();
    const store = {
      transaction: <T>(work: () => T) => work(),
      getSession: vi.fn((id) => sessions.get(id)),
      createSession: vi.fn((input) => {
        const row = { ...input, status: "idle" };
        sessions.set(row.id, row);
        return row;
      }),
      getSessionTask: vi.fn((id) => tasks.get(id)),
      getInput: vi.fn((id) => inputs.get(id)),
      admitPrompt: vi.fn((input) => {
        const row = { ...input };
        inputs.set(row.id, row);
        return row;
      }),
      getRun: vi.fn((id) => runs.get(id)),
      createRun: vi.fn((input) => {
        const row = { ...input, status: "pending" };
        runs.set(row.id, row);
        return row;
      }),
      updateRun: vi.fn((id, update) => {
        const row = Object.assign(runs.get(id) ?? { id }, update);
        runs.set(id, row);
        return row;
      }),
      appendEvent: vi.fn(),
    };
    const bridge = {
      registerChildExecution: vi.fn((input) => {
        tasks.set(input.id, { id: input.id, status: "pending" });
        return { id: input.id };
      }),
      bindChildExecutionRun: vi.fn(async (id, runId) => {
        Object.assign(tasks.get(id), { status: "running", runId });
      }),
      completeChildExecution: vi.fn(async (id, result) => {
        Object.assign(tasks.get(id), { status: result.status, output: result.output });
      }),
    };
    const liveDelta = {
      id: "delta-1",
      seq: 9,
      type: "session.message.part.delta",
      sessionId: "child-session",
      payload: { delta: "done" },
      createdAt: 1,
    };
    const transcript = {
      beginRun: vi.fn(() => ({ active: true })),
      projectSteeredInputs: vi.fn(),
      hasOpenTextPart: vi.fn(() => false),
      projectStreamEvent: vi.fn(() => ({ liveEvent: liveDelta })),
      completeOpenTextPart: vi.fn(),
      finalizeRunParts: vi.fn(),
    };
    const liveChildren = { register: vi.fn(), unregister: vi.fn() };
    const rootAgent = { children: { get: vi.fn() } } as any;
    const events = { checkpoint: vi.fn(() => 1), publish: vi.fn(), publishSince: vi.fn() };
    const projector = new DaemonAgentEventProjector({
      rootAgent,
      store: store as any,
      transcriptProjection: transcript as any,
      executionProjector: { createBridge: vi.fn(() => bridge) } as any,
      liveChildren,
      events,
      log: vi.fn(),
    });

    await projector.apply(event("child.created", {
      childId: "child-1",
      sessionId: "child-session",
      spawn: { description: "Explore", prompt: "inspect", agent: "Explore", cwd: "/repo" },
      cwd: "/repo",
    }, { sessionId: "parent", childId: "child-1" }));
    await projector.apply(event("input.accepted", {
      content: "inspect",
      delivery: "queue",
      metadata: { requestedBy: "test" },
    }, { sessionId: "child-session", inputId: "input-1", runId: "run-1", childId: "child-1" }));
    bridge.bindChildExecutionRun.mockRejectedValueOnce(new Error("bind failed"));
    const started = event("run.started", {}, {
      sessionId: "child-session",
      inputId: "input-1",
      runId: "run-1",
      childId: "child-1",
    });
    await expect(projector.apply(started)).rejects.toThrow("bind failed");
    expect(transcript.finalizeRunParts).toHaveBeenCalledWith("child-session", "run-1", "failed");
    expect(store.updateRun).toHaveBeenCalledWith("run-1", { status: "failed", error: "bind failed" });
    expect(bridge.completeChildExecution).toHaveBeenCalledWith("child-1", {
      status: "failed",
      output: "bind failed",
    });
    await projector.apply(event("input.accepted", {
      content: "continue",
      delivery: "queue",
    }, { sessionId: "child-session", inputId: "input-2", runId: "run-2", childId: "child-1" }));
    await projector.apply(event("run.started", {}, {
      sessionId: "child-session",
      inputId: "input-2",
      runId: "run-2",
      childId: "child-1",
    }));
    await projector.apply(event("output.text.delta", { delta: "done" }, {
      sessionId: "child-session",
      inputId: "input-2",
      runId: "run-2",
      childId: "child-1",
    }));
    await projector.apply(event("run.completed", { output: "done" }, {
      sessionId: "child-session",
      inputId: "input-2",
      runId: "run-2",
      childId: "child-1",
    }));

    expect(store.createSession).toHaveBeenCalledWith(expect.objectContaining({ id: "child-session", parentId: "parent" }));
    expect(store.admitPrompt).toHaveBeenCalledWith(expect.objectContaining({
      id: "input-1",
      metadata: expect.objectContaining({ requestedBy: "test" }),
    }));
    expect(bridge.registerChildExecution).toHaveBeenCalledWith(expect.objectContaining({ id: "child-1" }));
    expect(liveChildren.register).toHaveBeenCalledWith("child-session", "child-1", rootAgent);
    expect(transcript.projectStreamEvent).toHaveBeenCalledWith(expect.anything(), { type: "text_delta", delta: "done" });
    expect(events.publish).toHaveBeenCalledWith(liveDelta);
    expect(bridge.bindChildExecutionRun).toHaveBeenCalledTimes(2);
    expect(store.updateRun).toHaveBeenLastCalledWith("run-2", { status: "completed" });
    expect(bridge.completeChildExecution).toHaveBeenCalledWith("child-1", { status: "completed", output: "done" });
  });

  it("compensates durable child state when live route registration fails", async () => {
    const sessions = new Map<string, any>([[
      "parent",
      { id: "parent", cwd: "/repo", model: "gpt", metadata: { runtime: { model: "gpt" } } },
    ]]);
    const tasks = new Map<string, any>();
    const archiveSession = vi.fn((id) => {
      const session = sessions.get(id);
      Object.assign(session, { status: "archived" });
      return session;
    });
    const store = {
      getSession: vi.fn((id) => sessions.get(id)),
      createSession: vi.fn((input) => {
        const row = { ...input, status: "idle" };
        sessions.set(row.id, row);
        return row;
      }),
      archiveSession,
      getSessionTask: vi.fn((id) => tasks.get(id)),
      appendEvent: vi.fn(),
    };
    const completeChildExecution = vi.fn(async (id, result) => {
      Object.assign(tasks.get(id), { status: result.status, output: result.output });
    });
    const bridge = {
      registerChildExecution: vi.fn((input) => {
        const task = { id: input.id, status: "pending" };
        tasks.set(task.id, task);
        return task;
      }),
      completeChildExecution,
    };
    const liveChildren = {
      register: vi.fn(() => { throw new Error("route conflict"); }),
      unregister: vi.fn(),
    };
    const projector = new DaemonAgentEventProjector({
      rootAgent: { children: { get: vi.fn() } } as any,
      store: store as any,
      transcriptProjection: {} as any,
      executionProjector: { createBridge: vi.fn(() => bridge) } as any,
      liveChildren,
      events: { checkpoint: vi.fn(() => 1), publish: vi.fn(), publishSince: vi.fn() },
      log: vi.fn(),
    });

    await expect(projector.apply(event("child.created", {
      childId: "child-bad",
      sessionId: "child-session-bad",
      spawn: { description: "Explore", prompt: "inspect", agent: "Explore", cwd: "/repo" },
      cwd: "/repo",
    }, { sessionId: "parent", childId: "child-bad" }))).rejects.toThrow("route conflict");

    expect(completeChildExecution).toHaveBeenCalledWith("child-bad", {
      status: "failed",
      output: "route conflict",
    });
    expect(archiveSession).toHaveBeenCalledWith("child-session-bad");
    expect(sessions.get("child-session-bad")?.status).toBe("archived");
  });

  it("rejects replayed input ids whose durable metadata differs", async () => {
    const store = {
      transaction: <T>(work: () => T) => work(),
      getInput: vi.fn(() => ({
        id: "input-1",
        sessionId: "s1",
        content: "hello",
        delivery: "queue",
        metadata: { source: "first", traceId: "old-trace" },
      })),
    };
    const projector = new DaemonAgentEventProjector({
      rootAgent: { children: { get: vi.fn() } } as any,
      store: store as any,
      transcriptProjection: {} as any,
      executionProjector: {} as any,
      liveChildren: {} as any,
      events: { checkpoint: vi.fn(), publish: vi.fn(), publishSince: vi.fn() },
      log: vi.fn(),
    });

    await expect(projector.apply(event("input.accepted", {
      content: "hello",
      delivery: "queue",
      metadata: { source: "second" },
    }, { sessionId: "s1", inputId: "input-1", runId: "run-1" })))
      .rejects.toThrow("Agent input identity conflict");
  });

  it("rejects reuse of a durable child session by a different child identity", async () => {
    const store = {
      getSession: vi.fn((id) => id === "parent"
        ? { id: "parent", cwd: "/repo", model: "gpt", metadata: { runtime: { model: "gpt" } } }
        : { id: "child-session", parentId: "parent", cwd: "/repo", metadata: { childId: "old-child" } }),
    };
    const projector = new DaemonAgentEventProjector({
      rootAgent: { children: { get: vi.fn() } } as any,
      store: store as any,
      transcriptProjection: {} as any,
      executionProjector: {} as any,
      liveChildren: {} as any,
      events: { checkpoint: vi.fn(), publish: vi.fn(), publishSince: vi.fn() },
      log: vi.fn(),
    });

    await expect(projector.apply(event("child.created", {
      childId: "new-child",
      sessionId: "child-session",
      spawn: { description: "Explore", prompt: "inspect", agent: "Explore", cwd: "/repo" },
      cwd: "/repo",
    }, { sessionId: "parent", childId: "new-child" })))
      .rejects.toThrow("Child session identity conflict");
  });

  it("rejects child creation after the parent session starts closing", async () => {
    const projector = new DaemonAgentEventProjector({
      rootAgent: { children: { get: vi.fn() } } as any,
      store: {
        getSession: vi.fn(() => ({
          id: "parent",
          cwd: "/repo",
          model: "gpt",
          status: "closing",
          metadata: { runtime: { model: "gpt" } },
        })),
      } as any,
      transcriptProjection: {} as any,
      executionProjector: {} as any,
      liveChildren: {} as any,
      events: { checkpoint: vi.fn(), publish: vi.fn(), publishSince: vi.fn() },
      log: vi.fn(),
    });

    await expect(projector.apply(event("child.created", {
      childId: "late-child",
      sessionId: "late-child-session",
      spawn: { description: "Explore", prompt: "inspect", agent: "Explore", cwd: "/repo" },
      cwd: "/repo",
    }, { sessionId: "parent", childId: "late-child" })))
      .rejects.toThrow("Parent session is not accepting child agents");
  });

  it("retains and retries child close projection state after durable completion fails", async () => {
    const completeChildExecution = vi.fn()
      .mockRejectedValueOnce(new Error("store unavailable"))
      .mockRejectedValueOnce(new Error("store still unavailable"))
      .mockResolvedValueOnce(undefined);
    const liveChildren = { unregister: vi.fn() };
    const store = {
      getSessionTask: vi.fn(() => ({ id: "child-1", status: "running" })),
      appendEvent: vi.fn(),
    };
    const projector = new DaemonAgentEventProjector({
      rootAgent: { children: { get: vi.fn() } } as any,
      store: store as any,
      transcriptProjection: {} as any,
      executionProjector: {} as any,
      liveChildren: liveChildren as any,
      events: { checkpoint: vi.fn(), publish: vi.fn(), publishSince: vi.fn() },
      log: vi.fn(),
    });
    (projector as any).children.set("child-1", {
      childId: "child-1",
      sessionId: "child-session",
      parentSessionId: "parent",
      taskId: "child-1",
      bridge: { completeChildExecution },
    });

    const closed = event("child.closed", {
      childId: "child-1",
      sessionId: "child-session",
      result: { status: "completed", output: "done" },
    }, { sessionId: "parent", childId: "child-1" });
    await expect(projector.apply(closed)).rejects.toThrow("store unavailable");

    expect(liveChildren.unregister).toHaveBeenCalledWith("child-session", "child-1");
    expect((projector as any).children.size).toBe(1);

    await projector.apply(closed);

    expect(completeChildExecution).toHaveBeenCalledTimes(3);
    expect(store.appendEvent).toHaveBeenCalledOnce();
    expect((projector as any).children.size).toBe(0);
  });

  it("does not reopen a terminal durable run", async () => {
    const updateRun = vi.fn();
    const projector = new DaemonAgentEventProjector({
      rootAgent: { children: { get: vi.fn() } } as any,
      store: {
        transaction: <T>(work: () => T) => work(),
        getInput: vi.fn(() => ({ id: "input-1", sessionId: "s1", content: "hello" })),
        getRun: vi.fn(() => ({ id: "run-1", sessionId: "s1", inputId: "input-1", status: "failed" })),
        updateRun,
      } as any,
      transcriptProjection: {} as any,
      executionProjector: {} as any,
      liveChildren: {} as any,
      events: { checkpoint: vi.fn(() => 1), publish: vi.fn(), publishSince: vi.fn() },
      log: vi.fn(),
    });

    await expect(projector.apply(event("run.started", {}, {
      sessionId: "s1",
      inputId: "input-1",
      runId: "run-1",
    }))).rejects.toThrow("Agent run is already terminal");
    expect(updateRun).not.toHaveBeenCalled();
  });
});

let sequence = 0;

function event(
  type: AgentEvent["type"],
  data: Record<string, unknown>,
  context: Partial<AgentEvent["context"]>,
): AgentEvent {
  sequence += 1;
  return {
    id: `event-${sequence}`,
    sequence,
    occurredAt: new Date().toISOString(),
    type,
    data,
    context: {
      agentId: "agent-1",
      sessionId: "parent",
      traceId: "trace-1",
      ...context,
    },
  } as AgentEvent;
}
