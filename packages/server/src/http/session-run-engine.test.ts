import type { AgentRunHandle } from "@openharness/core";
import { describe, expect, it, vi } from "vitest";

import { SessionRunEngine } from "./session-run-engine.js";

describe("SessionRunEngine", () => {
  it("admits root work and forwards steer directly to the active handle", async () => {
    const store = createStore();
    const pending = deferred<void>();
    const steer = vi.fn(async (input) => ({ sessionId: "s1", inputId: input.id!, runId: "r1" }));
    const handle = runHandle(pending.promise, steer);
    const runExecutor = {
      execute: vi.fn(async (_input, context) => {
        await context.registerHandle(handle);
        await handle.result;
      }),
    };
    const engine = new SessionRunEngine({
      store: store as any,
      agentPool: { configured: true } as any,
      runExecutor: runExecutor as any,
      events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
    });

    const root = engine.admitPromptAndMaybeRun("s1", { content: "hello", traceId: "trace-1" });
    await vi.waitFor(() => expect(runExecutor.execute).toHaveBeenCalledOnce());
    const steered = engine.admitPromptAndMaybeRun("s1", {
      id: "steer-1",
      content: "nudge",
      delivery: "steer",
      traceId: "trace-2",
    });
    await vi.waitFor(() => expect(steer).toHaveBeenCalledOnce());

    expect(root.queue_state).toBe("running");
    expect(steered.run?.id).toBe(root.run?.id);
    expect(steer).toHaveBeenCalledWith(expect.objectContaining({ id: "steer-1", content: "nudge" }));
    pending.resolve();
    await engine.waitForRuns([root.run!.id]);
  });

  it("returns an existing prompt/run for an identical request id", () => {
    const store = createStore();
    const engine = new SessionRunEngine({
      store: store as any,
      agentPool: { configured: false } as any,
      runExecutor: {} as any,
      events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
    });
    const first = engine.admitPromptAndMaybeRun("s1", { id: "fixed", content: "hello" });
    const second = engine.admitPromptAndMaybeRun("s1", { id: "fixed", content: "hello" });
    expect(second.input).toBe(first.input);
  });
});

function createStore() {
  const inputs = new Map<string, any>();
  const runs = new Map<string, any>();
  let inputCount = 0;
  let runCount = 0;
  return {
    admitPrompt: vi.fn((input) => {
      const row = {
        ...input,
        id: input.id ?? `i${++inputCount}`,
        delivery: input.delivery ?? "queue",
        createdAt: 1,
      };
      inputs.set(row.id, row);
      return row;
    }),
    getInput: vi.fn((id) => inputs.get(id)),
    createRun: vi.fn((input) => {
      const row = { ...input, id: `r${++runCount}`, status: "pending", createdAt: 1, updatedAt: 1 };
      runs.set(row.id, row);
      return row;
    }),
    getRun: vi.fn((id) => runs.get(id)),
    findRunByInput: vi.fn((id) => [...runs.values()].find((run) => run.inputId === id)),
    updateRun: vi.fn(),
  };
}

function runHandle(done: Promise<void>, steer: AgentRunHandle["steer"]): AgentRunHandle {
  return {
    id: "r1",
    inputId: "i1",
    sessionId: "s1",
    traceId: "trace-1",
    result: done.then(() => ({
      status: "completed" as const,
      output: "ok",
      history: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    })),
    steer,
    interrupt: vi.fn(async () => {}),
  };
}

function deferred<T>() {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
