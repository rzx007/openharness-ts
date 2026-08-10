import { describe, expect, it, vi } from "vitest";

import { SessionRunExecutor } from "./session-run-executor.js";

describe("SessionRunExecutor", () => {
  it("closes the runtime and persists a failed terminal state", async () => {
    const session = {
      id: "s1",
      cwd: "/repo",
      model: "gpt-test",
      status: "idle",
      metadata: {},
    };
    const admitted = {
      id: "input-1",
      sessionId: "s1",
      content: "hello",
      metadata: {},
    };
    const store = {
      getSession: vi.fn(() => session),
      listMessages: vi.fn(() => []),
      listMessageParts: vi.fn(() => []),
      getInput: vi.fn(() => admitted),
      updateRun: vi.fn(),
      appendEvent: vi.fn(),
      listUnboundInputs: vi.fn(() => []),
    };
    const agentPool = {
      configured: true,
      acquire: vi.fn(async () => {
        throw new Error("agent failed");
      }),
      close: vi.fn(async () => {}),
    };
    const broadcastSince = vi.fn();
    const executor = new SessionRunExecutor({
      store: store as any,
      agentPool: agentPool as any,
      childAgentHostFactory: { create: vi.fn(() => ({}) as any) },
      permissionBroker: { ask: vi.fn() },
      transcriptProjection: {
        beginRun: vi.fn(() => ({})),
        projectSteeredInputs: vi.fn(),
        hasOpenTextPart: vi.fn(),
        projectStreamEvent: vi.fn(),
        completeOpenTextPart: vi.fn(),
      } as any,
      events: { checkpoint: () => 7, publishSince: broadcastSince, publish: vi.fn() },
      traceIdForRun: () => "trace-1",
      log: vi.fn(),
    });

    await executor.execute(
      { sessionId: "s1", inputId: "input-1", runId: "run-1" },
      { signal: new AbortController().signal, wakeCount: () => 0 },
    );

    expect(agentPool.close).toHaveBeenCalledWith("s1");
    expect(store.appendEvent).toHaveBeenCalledWith({
      type: "session.run.error",
      sessionId: "s1",
      payload: { runId: "run-1", traceId: "trace-1", error: "agent failed" },
    });
    expect(store.updateRun).toHaveBeenLastCalledWith("run-1", {
      status: "failed",
      error: "agent failed",
    });
    expect(broadcastSince).toHaveBeenLastCalledWith(7);
  });
});
