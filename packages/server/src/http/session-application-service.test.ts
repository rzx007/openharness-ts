import { describe, expect, it, vi } from "vitest";

import { SessionApplicationError, SessionApplicationService } from "./session-application-service.js";

const session = {
  id: "s1",
  cwd: "/repo",
  title: "Session",
  model: "gpt-test",
  status: "idle",
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
} as const;

function createService(options: {
  hasWork?: boolean;
  run?: Record<string, any>;
  input?: Record<string, any>;
  inputs?: Array<Record<string, any>>;
  live?: boolean;
} = {}) {
  const store = {
    createSession: vi.fn((input) => ({ ...session, ...input })),
    getSession: vi.fn(() => session),
    updateSession: vi.fn((_sessionId, input) => ({ ...session, ...input })),
    listChildSessions: vi.fn(() => []),
    beginArchive: vi.fn(),
    archiveSession: vi.fn(() => ({ ...session, status: "archived" })),
    getRun: vi.fn(() => options.run),
    getInput: vi.fn(() => options.input),
    listInputs: vi.fn(() => options.inputs ?? []),
    findRunByInput: vi.fn(),
    admitPrompt: vi.fn((input) => ({ id: input.id ?? "live-input", ...input })),
    appendEvent: vi.fn(),
  };
  const runEngine = {
    admitPromptAndMaybeRun: vi.fn(() => ({
      input: { id: "recovery-input", sessionId: "s1" },
      run: { id: "recovery-run", sessionId: "s1", status: "pending" },
      queue_state: "running",
    })),
    interruptSession: vi.fn(() => ({ interrupted: false, queuedRunIds: [] })),
    waitForRuns: vi.fn(async () => {}),
    hasWork: vi.fn(() => options.hasWork ?? false),
    hasAnyActiveRuns: vi.fn(() => false),
    hasActiveRunsForCwd: vi.fn(() => false),
  };
  const agentPool = {
    configured: true,
    warm: vi.fn(async () => {}),
    get: vi.fn(),
    close: vi.fn(async () => {}),
    closeForCwd: vi.fn(async () => {}),
    closeAll: vi.fn(async () => {}),
  };
  const broadcastSince = vi.fn();
  const liveChildren = {
    has: vi.fn(() => options.live ?? false),
    send: vi.fn(async () => options.live ? {
      sessionId: "s1",
      inputId: options.input?.id,
      runId: options.run?.id,
      result: Promise.resolve({ status: "completed" as const, output: "done" }),
    } : undefined),
    interrupt: vi.fn(async () => false),
  };
  const service = new SessionApplicationService({
    store: store as any,
    runEngine: runEngine as any,
    agentPool: agentPool as any,
    liveChildren,
    events: { checkpoint: () => 7, publishSince: broadcastSince },
  });
  return { service, store, runEngine, agentPool, liveChildren, broadcastSince };
}

describe("SessionApplicationService", () => {
  it("routes live child prompts back to framework controls without warming a second agent", async () => {
    const input = {
      id: "live-input",
      sessionId: "s1",
      delivery: "queue",
      content: "follow up",
      metadata: { requestedBy: "test" },
    };
    const run = { id: "live-run", sessionId: "s1", inputId: "live-input", status: "running" };
    const { service, store, runEngine, agentPool, liveChildren } = createService({ live: true, input, run });
    store.getInput.mockReturnValueOnce(undefined).mockReturnValue(input);

    service.getSession("s1", { warm: true });
    const admitted = await service.admitPrompt("s1", {
      id: "live-input",
      delivery: "queue",
      content: "follow up",
      metadata: { requestedBy: "test" },
    });

    expect(agentPool.warm).not.toHaveBeenCalled();
    expect(liveChildren.send).toHaveBeenCalledWith("s1", expect.objectContaining({
      id: "live-input",
      delivery: "queue",
      content: "follow up",
      metadata: { requestedBy: "test" },
    }));
    expect(runEngine.admitPromptAndMaybeRun).not.toHaveBeenCalled();
    expect(admitted).toMatchObject({ input, run, queue_state: "running" });
  });

  it("fails a live child prompt when its framework receipt was not durably projected", async () => {
    const { service, store, runEngine, liveChildren } = createService({ live: true });
    liveChildren.send.mockResolvedValue({
      sessionId: "s1",
      inputId: "missing-input",
      runId: "missing-run",
      result: Promise.resolve({ status: "completed" as const, output: "done" }),
    });

    await expect(service.admitPrompt("s1", { content: "follow up" })).rejects.toEqual(
      expect.objectContaining<Partial<SessionApplicationError>>({ status: 500 }),
    );
    expect(store.admitPrompt).not.toHaveBeenCalled();
    expect(runEngine.admitPromptAndMaybeRun).not.toHaveBeenCalled();
  });

  it("rejects a live child receipt whose run belongs to another input", async () => {
    const input = {
      id: "live-input",
      sessionId: "s1",
      delivery: "queue",
      content: "follow up",
      metadata: {},
    };
    const run = { id: "live-run", sessionId: "s1", inputId: "other-input", status: "running" };
    const { service, store } = createService({ live: true, input, run });
    store.getInput.mockReturnValueOnce(undefined).mockReturnValue(input);

    await expect(service.admitPrompt("s1", {
      id: "live-input",
      content: "follow up",
      delivery: "queue",
    })).rejects.toEqual(expect.objectContaining<Partial<SessionApplicationError>>({ status: 500 }));
  });

  it("creates a session, starts warming it, and publishes the store event", () => {
    const { service, agentPool, broadcastSince } = createService();

    const created = service.createSession({ cwd: "/repo", model: "gpt-test" });

    expect(created).toMatchObject({ cwd: "/repo", model: "gpt-test" });
    expect(agentPool.warm).toHaveBeenCalledWith("s1");
    expect(broadcastSince).toHaveBeenCalledWith(7);
  });

  it("rejects runtime-setting changes while the session has run work", async () => {
    const { service, store, agentPool } = createService({ hasWork: true });

    await expect(service.updateSession("s1", {
      metadata: { permissionMode: "strict" },
    })).rejects.toEqual(expect.objectContaining<Partial<SessionApplicationError>>({
      status: 409,
    }));
    expect(store.updateSession).not.toHaveBeenCalled();
    expect(agentPool.close).not.toHaveBeenCalled();
  });

  it("closes the runtime after changing runtime metadata", async () => {
    const { service, store, agentPool, broadcastSince } = createService();

    await service.updateSession("s1", { metadata: { permissionMode: "strict" } });

    expect(store.updateSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      metadata: { permissionMode: "strict" },
    }));
    expect(agentPool.close).toHaveBeenCalledWith("s1");
    expect(broadcastSince).toHaveBeenCalledWith(7);
  });

  it("resumes an interrupted run and records its recovery link", async () => {
    const sourceRun = {
      id: "source-run",
      sessionId: "s1",
      inputId: "source-input",
      status: "interrupted",
    };
    const sourceInput = {
      id: "source-input",
      sessionId: "s1",
      content: "retry this",
      metadata: {},
    };
    const { service, store, runEngine, broadcastSince } = createService({
      run: sourceRun,
      input: sourceInput,
    });

    const resumed = await service.resumeRun("s1", "source-run", {
      id: "recovery-input",
      metadata: { requestedBy: "test" },
      traceId: "trace-1",
    });

    expect(resumed.source_run).toBe(sourceRun);
    expect(runEngine.admitPromptAndMaybeRun).toHaveBeenCalledWith("s1", {
      id: "recovery-input",
      content: "retry this",
      metadata: {
        requestedBy: "test",
        recovery: {
          kind: "prompt_replay",
          sourceRunId: "source-run",
          sourceInputId: "source-input",
        },
      },
      runMetadata: {
        recovery: {
          kind: "prompt_replay",
          sourceRunId: "source-run",
          sourceInputId: "source-input",
        },
      },
      traceId: "trace-1",
    });
    expect(store.appendEvent).toHaveBeenCalledWith({
      type: "session.run.recovery_requested",
      sessionId: "s1",
      payload: {
        sourceRunId: "source-run",
        sourceInputId: "source-input",
        recoveryInputId: "recovery-input",
        recoveryRunId: "recovery-run",
      },
    });
    expect(broadcastSince).toHaveBeenCalledWith(7);
  });
});
