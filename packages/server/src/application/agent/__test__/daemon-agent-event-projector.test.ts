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
    const attempts = new Map<string, any>();
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
      listRunAttempts: vi.fn((runId) => [...attempts.values()].filter((attempt) => attempt.runId === runId)),
      createRunAttempt: vi.fn((input) => {
        const row = { ...input, status: "pending" };
        attempts.set(row.id, row);
        return row;
      }),
      updateRunAttempt: vi.fn((id, update) => {
        const row = Object.assign(attempts.get(id), update);
        attempts.set(id, row);
        return row;
      }),
      settleActiveRunAttempts: vi.fn((runId, status, error) => {
        for (const attempt of attempts.values()) {
          if (attempt.runId === runId && (attempt.status === "pending" || attempt.status === "running")) {
            Object.assign(attempt, { status }, error ? { error } : {});
          }
        }
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
    expect([...attempts.values()]).toMatchObject([
      { id: "attempt_run-1_1", runId: "run-1", sequence: 1, status: "failed" },
      { id: "attempt_run-2_1", runId: "run-2", sequence: 1, status: "completed" },
    ]);
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

  it("accepts model-facing content transformed from an admitted attachment input", async () => {
    const input = {
      id: "input-1",
      sessionId: "s1",
      content: "内容",
      delivery: "queue",
      metadata: { origin: { client: "desktop" } },
      attachments: [{ assetId: "image-1" }],
    };
    const store = {
      transaction: <T>(work: () => T) => work(),
      getInput: vi.fn(() => input),
      getRun: vi.fn(() => ({
        id: "run-1",
        sessionId: "s1",
        inputId: input.id,
        metadata: { attachmentRouting: { status: "completed" } },
      })),
    };
    const events = { checkpoint: vi.fn(), publish: vi.fn(), publishSince: vi.fn() };
    const projector = new DaemonAgentEventProjector({
      rootAgent: { children: { get: vi.fn() } } as any,
      store: store as any,
      transcriptProjection: {} as any,
      executionProjector: {} as any,
      liveChildren: {} as any,
      events,
      log: vi.fn(),
    });

    await expect(projector.apply(event("input.accepted", {
      content: [
        { type: "text", text: "内容" },
        { type: "image", image: "data:image/png;base64,aW1hZ2U=" },
      ],
      delivery: "queue",
      metadata: input.metadata,
    }, { sessionId: "s1", inputId: input.id, runId: "run-1" }))).resolves.toBeUndefined();

    expect(events.publishSince).toHaveBeenCalled();
  });

  it("accepts model-facing content transformed from an admitted slash skill input", async () => {
    const input = {
      id: "input-1",
      sessionId: "s1",
      content: "这是什么技能",
      delivery: "queue",
      metadata: {
        skillInvocation: {
          name: "agent-reach",
          commandName: "agent-reach",
          source: "project",
          invocationSource: "slash",
        },
      },
      attachments: [],
    };
    const store = {
      transaction: <T>(work: () => T) => work(),
      getInput: vi.fn(() => input),
    };
    const events = { checkpoint: vi.fn(), publish: vi.fn(), publishSince: vi.fn() };
    const projector = new DaemonAgentEventProjector({
      rootAgent: { children: { get: vi.fn() } } as any,
      store: store as any,
      transcriptProjection: {} as any,
      executionProjector: {} as any,
      liveChildren: {} as any,
      events,
      log: vi.fn(),
    });

    await expect(projector.apply(event("input.accepted", {
      content: '请先使用 Skill 工具加载 "agent-reach" 技能，然后按该技能要求完成下面的任务：\n\n这是什么技能',
      delivery: "queue",
      metadata: input.metadata,
    }, { sessionId: "s1", inputId: input.id, runId: "run-1" }))).resolves.toBeUndefined();

    expect(events.publishSince).toHaveBeenCalled();
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
    let settlement: any;
    const store = {
      getSessionTask: vi.fn(() => ({ id: "child-1", status: "running" })),
      appendEvent: vi.fn(),
      createProjectionSettlement: vi.fn((input) => {
        settlement ??= {
          ...input,
          id: "settlement-1",
          status: "pending",
          attemptCount: 0,
          createdAt: 1,
          updatedAt: 1,
        };
        return settlement;
      }),
      listProjectionSettlements: vi.fn(() =>
        settlement && (settlement.status === "pending" || settlement.status === "retrying")
          ? [settlement]
          : []),
      markProjectionSettlementRetrying: vi.fn(() => {
        Object.assign(settlement, { status: "retrying", attemptCount: settlement.attemptCount + 1 });
        return settlement;
      }),
      failProjectionSettlement: vi.fn((_id, error) => {
        Object.assign(settlement, { status: "pending", lastError: error });
        return settlement;
      }),
      resolveProjectionSettlement: vi.fn(() => {
        Object.assign(settlement, { status: "resolved" });
        return settlement;
      }),
    };
    const projector = new DaemonAgentEventProjector({
      projectorId: "daemon-agent:agent-1",
      rootSessionId: "parent",
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
    expect(store.createProjectionSettlement).toHaveBeenCalledOnce();
    expect(settlement).toMatchObject({ status: "resolved", attemptCount: 2 });
  });

  it("does not hide the original projection error when settlement persistence also fails", async () => {
    const projector = new DaemonAgentEventProjector({
      projectorId: "daemon-agent:agent-1",
      rootSessionId: "parent",
      rootAgent: { children: { get: vi.fn() } } as any,
      store: {
        listProjectionSettlements: vi.fn(() => []),
        getSession: vi.fn(() => undefined),
        createProjectionSettlement: vi.fn(() => { throw new Error("sqlite unavailable"); }),
      } as any,
      transcriptProjection: {} as any,
      executionProjector: {} as any,
      liveChildren: {} as any,
      events: { checkpoint: vi.fn(), publish: vi.fn(), publishSince: vi.fn() },
      log: vi.fn(),
    });

    const failure = await projector.apply(event("child.created", {
      childId: "child-1",
      sessionId: "child-session",
      spawn: { description: "Explore", prompt: "inspect", agent: "Explore", cwd: "/repo" },
      cwd: "/repo",
    }, { sessionId: "parent", childId: "child-1" })).catch((error) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.message).toContain("settlement could not be persisted");
    expect((failure as AggregateError).errors.map((error) => error.message)).toEqual([
      expect.stringContaining("Parent session not found"),
      "sqlite unavailable",
    ]);
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

  it("stores domain events under one registered type and keeps the domain name in the payload", async () => {
    const durableEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const appendEvent = vi.fn((input) => { durableEvents.push(input); });
    const projector = new DaemonAgentEventProjector({
      rootAgent: { children: { get: vi.fn() } } as any,
      store: { appendEvent, listEvents: vi.fn(() => durableEvents) } as any,
      transcriptProjection: {} as any,
      executionProjector: {} as any,
      liveChildren: {} as any,
      events: { checkpoint: vi.fn(() => 1), publish: vi.fn(), publishSince: vi.fn() },
      log: vi.fn(),
    });

    const domainEvent = event("domain.event", {
      name: "provider.rate_limited",
      payload: { retryAfterMs: 1_000 },
    }, { sessionId: "s1" });
    await projector.apply(domainEvent);

    expect(appendEvent).toHaveBeenCalledWith({
      type: "agent.domain.event",
      sessionId: "s1",
      payload: {
        frameworkEventId: domainEvent.id,
        name: "provider.rate_limited",
        payload: { retryAfterMs: 1_000 },
      },
    });

    // Simulate durable projection succeeding just before settlement resolution failed.
    (projector as any).lastAppliedSequence = 0;
    await projector.apply(domainEvent);
    expect(appendEvent).toHaveBeenCalledOnce();
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
