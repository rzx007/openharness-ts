import { describe, expect, it, vi } from "vitest";

import { SessionRunRenderer } from "./run-renderer.js";
import { SessionRunEngine } from "./session-run-engine.js";
import { SessionRunExecutor } from "./session-run-executor.js";
import { SessionRuntimePool } from "./session-runtime-pool.js";

function createStore() {
  const inputs = new Map<string, any>();
  const runs = new Map<string, any>();
  let inputCount = 0;
  let runCount = 0;
  let messageCount = 0;
  let partCount = 0;
  return {
    admitPrompt: vi.fn((input) => {
      const record = {
        id: input.id ?? `i${++inputCount}`,
        seq: inputCount,
        delivery: input.delivery,
        content: input.content,
        metadata: input.metadata,
        sessionId: input.sessionId,
        createdAt: 1,
      };
      inputs.set(record.id, record);
      return record;
    }),
    appendEvent: vi.fn(),
    appendMessagePartDelta: vi.fn((input) => ({
      id: "e1",
      seq: 1,
      type: "session.message_part.delta",
      sessionId: input.sessionId,
      payload: input,
      createdAt: 1,
    })),
    createMessage: vi.fn((input) => ({
      id: `m${++messageCount}`,
      seq: messageCount,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
      ...input,
    })),
    createRun: vi.fn((input) => {
      const record = {
        id: `r${++runCount}`,
        status: "pending",
        createdAt: 1,
        updatedAt: 1,
        ...input,
      };
      runs.set(record.id, record);
      return record;
    }),
    findRunByInput: vi.fn((inputId) => [...runs.values()].find((run) => run.inputId === inputId)),
    getInput: vi.fn((inputId) => inputs.get(inputId)),
    getRun: vi.fn((runId) => runs.get(runId)),
    getSession: vi.fn((sessionId) => ({
      id: sessionId,
      cwd: "/repo",
      title: "Session",
      model: "gpt-test",
      status: "idle",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    })),
    listMessageParts: vi.fn(() => []),
    listMessages: vi.fn(() => []),
    listSessions: vi.fn(() => []),
    listUnboundInputs: vi.fn(() => []),
    updateRun: vi.fn((runId, input) => {
      const existing = runs.get(runId);
      const updated = { ...existing, ...input, metadata: { ...(existing?.metadata ?? {}), ...(input.metadata ?? {}) } };
      runs.set(runId, updated);
      return updated;
    }),
    upsertMessagePart: vi.fn((input) => ({
      id: input.id ?? `p${++partCount}`,
      seq: partCount,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
      ...input,
    })),
  };
}

function createEngine(store = createStore()) {
  const runRenderer = new SessionRunRenderer(store as any);
  const runPrompt = vi.fn(async () => {});
  const runtimePool = new SessionRuntimePool({
    store: store as any,
    runtimeFactory: {
      createRuntime: vi.fn(async () => ({
        runPrompt,
        close: vi.fn(async () => {}),
      })),
    },
  });
  const runExecutor = new SessionRunExecutor({
    store: store as any,
    runtimePool,
    childAgentHostFactory: { create: vi.fn(() => ({}) as any) },
    permissionBroker: { ask: vi.fn() },
    runRenderer,
    events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn(), publish: vi.fn() },
    traceIdForRun: vi.fn((runId) => store.getRun(runId)?.metadata.traceId ?? `trace-${runId}`),
    log: vi.fn(),
  });
  const engine = new SessionRunEngine({
    store: store as any,
    runtimePool,
    runExecutor,
    events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
  });
  return { engine, store, runPrompt };
}

async function flushRun(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("SessionRunEngine", () => {
  it("admits prompts and drives runtime runs to completion", async () => {
    const { engine, store, runPrompt } = createEngine();

    const admitted = engine.admitPromptAndMaybeRun("s1", { content: "hello", traceId: "trace-1" });
    await flushRun();

    expect(admitted.input).toMatchObject({ sessionId: "s1", content: "hello" });
    expect(admitted.run).toMatchObject({ sessionId: "s1", inputId: admitted.input.id });
    expect(admitted.queue_state).toBe("running");
    expect(runPrompt).toHaveBeenCalledOnce();
    expect(store.updateRun).toHaveBeenCalledWith(admitted.run!.id, { status: "running" });
    expect(store.updateRun).toHaveBeenCalledWith(admitted.run!.id, { status: "completed" });
  });

  it("returns existing prompt/run for identical prompt ids", () => {
    const { engine } = createEngine();

    const first = engine.admitPromptAndMaybeRun("s1", { id: "fixed", content: "hello", traceId: "trace-1" });
    const second = engine.admitPromptAndMaybeRun("s1", { id: "fixed", content: "hello", traceId: "trace-2" });

    expect(second.input).toBe(first.input);
    expect(second.run?.id).toBe(first.run?.id);
  });

  it("rejects reused prompt ids with different content", () => {
    const { engine } = createEngine();

    engine.admitPromptAndMaybeRun("s1", { id: "fixed", content: "hello" });

    expect(() => engine.admitPromptAndMaybeRun("s1", { id: "fixed", content: "changed" }))
      .toThrow("Prompt id is already used: fixed");
  });
});
