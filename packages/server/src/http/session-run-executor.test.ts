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
    const runtimePool = {
      configured: true,
      acquire: vi.fn(async () => {
        throw new Error("runtime failed");
      }),
      close: vi.fn(async () => {}),
    };
    const broadcastSince = vi.fn();
    const executor = new SessionRunExecutor({
      store: store as any,
      runtimePool: runtimePool as any,
      childAgentHostFactory: { create: vi.fn(() => ({}) as any) },
      permissionBroker: { ask: vi.fn() },
      runRenderer: {
        createState: vi.fn(() => ({})),
        drainSteeredInputs: vi.fn(),
        hasActiveTextPart: vi.fn(),
        applyStreamEvent: vi.fn(),
        completeActiveTextPart: vi.fn(),
      } as any,
      events: { checkpoint: () => 7, publishSince: broadcastSince, publish: vi.fn() },
      traceIdForRun: () => "trace-1",
      log: vi.fn(),
    });

    await executor.execute(
      { sessionId: "s1", inputId: "input-1", runId: "run-1" },
      { signal: new AbortController().signal, wakeCount: () => 0 },
    );

    expect(runtimePool.close).toHaveBeenCalledWith("s1");
    expect(store.appendEvent).toHaveBeenCalledWith({
      type: "session.run.error",
      sessionId: "s1",
      payload: { runId: "run-1", traceId: "trace-1", error: "runtime failed" },
    });
    expect(store.updateRun).toHaveBeenLastCalledWith("run-1", {
      status: "failed",
      error: "runtime failed",
    });
    expect(broadcastSince).toHaveBeenLastCalledWith(7);
  });
});
