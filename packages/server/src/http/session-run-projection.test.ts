import { describe, expect, it, vi } from "vitest";

import { DaemonRunProjection } from "./session-run-projection.js";

function scope() {
  return {
    sessionId: "s1",
    runId: "run1",
    inputId: "input1",
    cwd: "/repo",
    traceId: "trace1",
    signal: new AbortController().signal,
  };
}

describe("DaemonRunProjection", () => {
  it("projects host callbacks into store, publisher, permission broker, and logs", async () => {
    const store = {
      appendEvent: vi.fn(),
      listUnboundInputs: vi.fn(() => []),
      updateRun: vi.fn(),
    };
    const permissionBroker = {
      ask: vi.fn(async () => true),
    };
    const runRenderer = {
      createState: vi.fn(() => ({ active: true })),
      drainSteeredInputs: vi.fn(),
      hasActiveTextPart: vi.fn(() => false),
      applyStreamEvent: vi.fn(() => ({})),
      completeActiveTextPart: vi.fn(),
    };
    const events = {
      checkpoint: vi.fn(() => 7),
      publish: vi.fn(),
      publishSince: vi.fn(),
    };
    const log = vi.fn();
    const projection = new DaemonRunProjection({
      store: store as any,
      permissionBroker,
      runRenderer: runRenderer as any,
      events,
      sessionId: "s1",
      inputId: "input1",
      runId: "run1",
      traceId: "trace1",
      signal: scope().signal,
      log,
    });

    projection.start("hello");
    const host = projection.createHost(scope(), {
      spawnChildAgent: vi.fn(),
      sendChildInput: vi.fn(),
      interruptChildAgent: vi.fn(),
      awaitChildAgent: vi.fn(),
    });
    await host.emitEvent({ type: "runtime.custom", payload: { ok: true } });
    await host.requestPermission({ toolName: "Write", input: { file: "a.txt" } });
    await host.emitStreamEvent({
      type: "tool_use_start",
      toolUse: { id: "tool-1", name: "Write", input: { file: "a.txt" } },
    });
    projection.complete(false);

    expect(store.updateRun).toHaveBeenCalledWith("run1", { status: "running" });
    expect(store.appendEvent).toHaveBeenCalledWith({
      type: "runtime.custom",
      sessionId: "s1",
      payload: { ok: true },
    });
    expect(permissionBroker.ask).toHaveBeenCalledWith({
      sessionId: "s1",
      runId: "run1",
      traceId: "trace1",
      toolName: "Write",
      reason: undefined,
      input: { file: "a.txt" },
      signal: expect.any(AbortSignal),
    });
    expect(runRenderer.applyStreamEvent).toHaveBeenCalledWith(expect.anything(), {
      type: "tool_use_start",
      toolUse: { id: "tool-1", name: "Write", input: { file: "a.txt" } },
    });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "session.tool.started",
      toolName: "Write",
    }));
    expect(store.updateRun).toHaveBeenLastCalledWith("run1", { status: "completed" });
    expect(events.publishSince).toHaveBeenCalledWith(7);
  });
});
