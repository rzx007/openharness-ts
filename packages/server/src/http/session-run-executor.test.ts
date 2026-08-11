import type { AgentRunHandle } from "@openharness/core";
import { describe, expect, it, vi } from "vitest";

import { SessionRunExecutor } from "./session-run-executor.js";

describe("SessionRunExecutor", () => {
  it("submits admitted identities and registers the live run handle", async () => {
    const handle = completedHandle();
    const submitMessage = vi.fn(() => handle);
    const agent = { setModel: vi.fn(), submitMessage };
    const store = createStore();
    const executor = new SessionRunExecutor({
      store: store as any,
      agentPool: {
        configured: true,
        acquire: vi.fn(async () => agent),
        close: vi.fn(async () => {}),
      } as any,
      events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
      transcriptProjection: { finalizeRunParts: vi.fn() },
      traceIdForRun: () => "trace-1",
      log: vi.fn(),
    });
    const registerHandle = vi.fn(async () => {});

    await executor.execute(
      { sessionId: "s1", inputId: "input-1", runId: "run-1" },
      { signal: new AbortController().signal, registerHandle },
    );

    expect(submitMessage).toHaveBeenCalledWith("hello", {
      signal: expect.any(AbortSignal),
      delivery: "queue",
      metadata: { requestedBy: "test", traceId: "trace-1" },
      ids: { inputId: "input-1", runId: "run-1", traceId: "trace-1" },
    });
    expect(registerHandle).toHaveBeenCalledWith(handle);
  });

  it("falls back to a durable failure when agent creation fails before events", async () => {
    const store = createStore();
    const publishSince = vi.fn();
    const close = vi.fn(async () => {});
    const finalizeRunParts = vi.fn();
    const executor = new SessionRunExecutor({
      store: store as any,
      agentPool: {
        configured: true,
        acquire: vi.fn(async () => { throw new Error("agent failed"); }),
        close,
      } as any,
      events: { checkpoint: () => 7, publishSince },
      transcriptProjection: { finalizeRunParts },
      traceIdForRun: () => "trace-1",
      log: vi.fn(),
    });

    await executor.execute(
      { sessionId: "s1", inputId: "input-1", runId: "run-1" },
      { signal: new AbortController().signal, registerHandle: vi.fn() },
    );

    expect(close).toHaveBeenCalledWith("s1");
    expect(finalizeRunParts).toHaveBeenCalledWith("s1", "run-1", "failed");
    expect(store.updateRun).toHaveBeenCalledWith("run-1", { status: "failed", error: "agent failed" });
    expect(publishSince).toHaveBeenCalledWith(7);
  });
});

function createStore() {
  const run = { id: "run-1", sessionId: "s1", inputId: "input-1", status: "pending" };
  return {
    transaction: <T>(work: () => T) => work(),
    getSession: vi.fn(() => ({ id: "s1", cwd: "/repo", model: "gpt-test", metadata: {} })),
    getInput: vi.fn(() => ({
      id: "input-1",
      sessionId: "s1",
      content: "hello",
      delivery: "queue",
      metadata: { requestedBy: "test", traceId: "trace-1" },
    })),
    getRun: vi.fn(() => run),
    listMessages: vi.fn(() => []),
    listMessageParts: vi.fn(() => []),
    appendEvent: vi.fn(),
    updateRun: vi.fn((id, update) => Object.assign(run, update, { id })),
  };
}

function completedHandle(): AgentRunHandle {
  return {
    id: "run-1",
    inputId: "input-1",
    sessionId: "s1",
    traceId: "trace-1",
    started: Promise.resolve({ sessionId: "s1", inputId: "input-1", runId: "run-1" }),
    result: Promise.resolve({
      status: "completed",
      output: "ok",
      history: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
    steer: vi.fn(),
    interrupt: vi.fn(),
  };
}
