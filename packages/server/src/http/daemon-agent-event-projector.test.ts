import type { AgentEvent } from "@openharness/core";
import { describe, expect, it, vi } from "vitest";

import { DaemonAgentEventProjector } from "./daemon-agent-event-projector.js";

describe("DaemonAgentEventProjector", () => {
  it("projects child and run facts without returning execution handles", async () => {
    const sessions = new Map<string, any>([["parent", { id: "parent", cwd: "/repo", model: "gpt" }]]);
    const inputs = new Map<string, any>();
    const runs = new Map<string, any>();
    const tasks = new Map<string, any>();
    const store = {
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
      registerSessionTask: vi.fn((input) => {
        tasks.set(input.id, { id: input.id, status: "pending" });
        return { id: input.id };
      }),
      bindSessionTaskRun: vi.fn(async (id, runId) => {
        Object.assign(tasks.get(id), { status: "running", runId });
      }),
      completeSessionTask: vi.fn(async (id, result) => {
        Object.assign(tasks.get(id), { status: result.status, output: result.output });
      }),
    };
    const transcript = {
      beginRun: vi.fn(() => ({ active: true })),
      projectSteeredInputs: vi.fn(),
      hasOpenTextPart: vi.fn(() => false),
      projectStreamEvent: vi.fn(() => ({})),
      completeOpenTextPart: vi.fn(),
    };
    const liveChildren = { register: vi.fn(), unregister: vi.fn() };
    const rootAgent = { children: { get: vi.fn() } } as any;
    const projector = new DaemonAgentEventProjector({
      rootAgent,
      store: store as any,
      transcriptProjection: transcript as any,
      taskBridgeManager: { createBridge: vi.fn(() => bridge) } as any,
      liveChildren,
      events: { checkpoint: vi.fn(() => 1), publish: vi.fn(), publishSince: vi.fn() },
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
    }, { sessionId: "child-session", inputId: "input-1", runId: "run-1", childId: "child-1" }));
    await projector.apply(event("run.started", {}, {
      sessionId: "child-session",
      inputId: "input-1",
      runId: "run-1",
      childId: "child-1",
    }));
    await projector.apply(event("output.text.delta", { delta: "done" }, {
      sessionId: "child-session",
      inputId: "input-1",
      runId: "run-1",
      childId: "child-1",
    }));
    await projector.apply(event("run.completed", { output: "done" }, {
      sessionId: "child-session",
      inputId: "input-1",
      runId: "run-1",
      childId: "child-1",
    }));

    expect(store.createSession).toHaveBeenCalledWith(expect.objectContaining({ id: "child-session", parentId: "parent" }));
    expect(bridge.registerSessionTask).toHaveBeenCalledWith(expect.objectContaining({ id: "child-1" }));
    expect(liveChildren.register).toHaveBeenCalledWith("child-session", "child-1", rootAgent);
    expect(transcript.projectStreamEvent).toHaveBeenCalledWith(expect.anything(), { type: "text_delta", delta: "done" });
    expect(store.updateRun).toHaveBeenLastCalledWith("run-1", { status: "completed" });
    expect(bridge.completeSessionTask).toHaveBeenCalledWith("child-1", { status: "completed", output: "done" });
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
