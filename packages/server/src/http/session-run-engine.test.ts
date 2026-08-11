import { AgentRunNotAcceptingInputError, type AgentRunHandle } from "@openharness/core";
import { describe, expect, it, vi } from "vitest";

import { SessionRunEngine } from "./session-run-engine.js";
import { RunInterruptedError } from "../run-coordinator.js";

describe("SessionRunEngine", () => {
  it("admits root work and forwards steer directly to the active handle", async () => {
    const store = createStore();
    const pending = deferred<void>();
    const steer = vi.fn(async (input) => {
      store.bindInputToRun(input.id!, "r1");
      return { sessionId: "s1", inputId: input.id!, runId: "r1" };
    });
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

    const root = await engine.admitPromptAndMaybeRun("s1", { content: "hello", traceId: "trace-1" });
    await vi.waitFor(() => expect(runExecutor.execute).toHaveBeenCalledOnce());
    const steered = await engine.admitPromptAndMaybeRun("s1", {
      id: "steer-1",
      content: "nudge",
      delivery: "steer",
      traceId: "trace-2",
    });
    await vi.waitFor(() => expect(steer).toHaveBeenCalledOnce());

    expect(root.queue_state).toBe("running");
    expect(steered.run?.id).toBe(root.run?.id);
    await expect(engine.admitPromptAndMaybeRun("s1", {
      id: "steer-1",
      content: "nudge",
      delivery: "steer",
      traceId: "retry-trace",
    })).resolves.toMatchObject({ run: { id: root.run?.id } });
    expect(steer).toHaveBeenCalledOnce();
    expect(steer).toHaveBeenCalledWith(expect.objectContaining({ id: "steer-1", content: "nudge" }));
    pending.resolve();
    await engine.waitForRuns([root.run!.id]);
  });

  it("shares one pending delivery for concurrent requests with the same input id", async () => {
    const store = createStore();
    const runDone = deferred<void>();
    const delivery = deferred<{ sessionId: string; inputId: string; runId: string }>();
    const steer = vi.fn(async (input) => {
      store.bindInputToRun(input.id!, "r1");
      return await delivery.promise;
    });
    const handle = runHandle(runDone.promise, steer);
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
    await engine.admitPromptAndMaybeRun("s1", { content: "root" });
    await vi.waitFor(() => expect(runExecutor.execute).toHaveBeenCalledOnce());

    const first = engine.admitPromptAndMaybeRun("s1", {
      id: "same-steer",
      content: "nudge",
      delivery: "steer",
    });
    const duplicate = engine.admitPromptAndMaybeRun("s1", {
      id: "same-steer",
      content: "nudge",
      delivery: "steer",
    });

    expect(duplicate).toBe(first);
    await vi.waitFor(() => expect(steer).toHaveBeenCalledOnce());
    delivery.resolve({ sessionId: "s1", inputId: "same-steer", runId: "r1" });
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      expect.objectContaining({ run: expect.objectContaining({ id: "r1" }) }),
      expect.objectContaining({ run: expect.objectContaining({ id: "r1" }) }),
    ]);
    runDone.resolve();
  });

  it("terminalizes a steer input interrupted before delivery", async () => {
    const store = createStore();
    const runDone = deferred<void>();
    const delivery = deferred<{ sessionId: string; inputId: string; runId: string }>();
    const handle = runHandle(
      runDone.promise,
      vi.fn(async () => await delivery.promise),
      vi.fn(async () => delivery.reject(new AgentRunNotAcceptingInputError("r1"))),
    );
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
    await engine.admitPromptAndMaybeRun("s1", { content: "root" });
    await vi.waitFor(() => expect(runExecutor.execute).toHaveBeenCalledOnce());
    const steered = engine.admitPromptAndMaybeRun("s1", {
      id: "interrupted-steer",
      content: "stop this",
      delivery: "steer",
    });
    await vi.waitFor(() => expect(handle.steer).toHaveBeenCalledOnce());

    engine.interruptSession("s1");

    await expect(steered).rejects.toBeInstanceOf(RunInterruptedError);
    expect(store.findRunByInput("interrupted-steer")).toMatchObject({
      status: "interrupted",
      error: "Steered input interrupted",
    });
    await expect(engine.admitPromptAndMaybeRun("s1", {
      id: "interrupted-steer",
      content: "stop this",
      delivery: "steer",
    })).resolves.toMatchObject({ run: { status: "interrupted" } });
  });

  it("returns an existing prompt/run for an identical request id", async () => {
    const store = createStore();
    const engine = new SessionRunEngine({
      store: store as any,
      agentPool: { configured: false } as any,
      runExecutor: {} as any,
      events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
    });
    const first = await engine.admitPromptAndMaybeRun("s1", { id: "fixed", content: "hello" });
    const second = await engine.admitPromptAndMaybeRun("s1", { id: "fixed", content: "hello" });
    expect(second.input).toBe(first.input);
  });

  it("queues a durable replacement run when a late steer is rejected", async () => {
    const store = createStore();
    const pending = deferred<void>();
    const handle = runHandle(
      pending.promise,
      vi.fn(async (input) => {
        store.bindInputToRun(input.id!, "r1");
        throw new AgentRunNotAcceptingInputError("r1");
      }),
    );
    let execution = 0;
    const runExecutor = {
      execute: vi.fn(async (_input, context) => {
        execution += 1;
        if (execution === 1) {
          await context.registerHandle(handle);
          await pending.promise;
        }
      }),
    };
    const engine = new SessionRunEngine({
      store: store as any,
      agentPool: { configured: true } as any,
      runExecutor: runExecutor as any,
      events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
    });

    await engine.admitPromptAndMaybeRun("s1", { content: "first" });
    await vi.waitFor(() => expect(runExecutor.execute).toHaveBeenCalledOnce());
    const steered = engine.admitPromptAndMaybeRun("s1", {
      id: "late-input",
      content: "late",
      delivery: "steer",
    });
    await vi.waitFor(() => expect(store.createRun).toHaveBeenCalledTimes(2));
    const replacement = store.createRun.mock.results[1]?.value;
    expect(replacement).toMatchObject({
      inputId: "late-input",
      metadata: expect.objectContaining({ recoveredFromSteer: true }),
    });
    await expect(steered).resolves.toMatchObject({
      input: { id: "late-input" },
      run: { id: replacement.id },
      queue_state: "queued",
    });

    pending.resolve();
    await vi.waitFor(() => expect(runExecutor.execute).toHaveBeenCalledTimes(2));
  });

  it("stops admission, interrupts the active lane, and never starts queued work during shutdown", async () => {
    const store = createStore();
    const activeDone = deferred<void>();
    const handle = runHandle(
      activeDone.promise,
      vi.fn(),
      vi.fn(async () => activeDone.resolve()),
    );
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

    await engine.admitPromptAndMaybeRun("s1", { content: "active" });
    await engine.admitPromptAndMaybeRun("s1", { content: "queued" });
    await vi.waitFor(() => expect(runExecutor.execute).toHaveBeenCalledOnce());

    await engine.stopAndDrain();

    expect(runExecutor.execute).toHaveBeenCalledOnce();
    expect(handle.interrupt).toHaveBeenCalledWith("Daemon shutting down");
    await expect(engine.admitPromptAndMaybeRun("s1", { content: "too late" }))
      .rejects.toThrow("stopping");
  });
});

function createStore() {
  const inputs = new Map<string, any>();
  const runs = new Map<string, any>();
  const inputOwners = new Map<string, string>();
  let inputCount = 0;
  let runCount = 0;
  return {
    transaction: <T>(work: () => T) => work(),
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
    findRunByInput: vi.fn((id) => {
      const direct = [...runs.values()].find((run) => run.inputId === id);
      return direct ?? runs.get(inputOwners.get(id));
    }),
    updateRun: vi.fn((id, update) => {
      const run = Object.assign(runs.get(id), update);
      runs.set(id, run);
      return run;
    }),
    appendEvent: vi.fn(),
    bindInputToRun: (inputId: string, runId: string) => inputOwners.set(inputId, runId),
  };
}

function runHandle(
  done: Promise<void>,
  steer: AgentRunHandle["steer"],
  interrupt = vi.fn(async () => {}),
): AgentRunHandle {
  return {
    id: "r1",
    inputId: "i1",
    sessionId: "s1",
    traceId: "trace-1",
    started: Promise.resolve({ sessionId: "s1", inputId: "i1", runId: "r1" }),
    result: done.then(() => ({
      status: "completed" as const,
      output: "ok",
      history: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    })),
    steer,
    interrupt,
  };
}

function deferred<T>() {
  let resolve!: (value?: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
