import { describe, expect, it, vi } from "vitest";

import { SessionApplicationError, SessionApplicationService } from "../session-application-service.js";
import { DaemonOperationGate } from "../../control/daemon-operation-gate.js";

const session = {
  id: "s1",
  cwd: "/repo",
  title: "Session",
  model: "gpt-test",
  status: "idle",
  metadata: { runtime: { model: "gpt-test" } },
  createdAt: 1,
  updatedAt: 1,
} as const;

function createService(options: {
  hasWork?: boolean;
  run?: Record<string, any>;
  input?: Record<string, any>;
  inputs?: Array<Record<string, any>>;
  live?: boolean;
  owningRun?: Record<string, any>;
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
    findRunByInput: vi.fn(() => options.owningRun),
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
    hasActiveWorkForSession: vi.fn(() => false),
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
  const operationGate = new DaemonOperationGate();
  const service = new SessionApplicationService({
    store: store as any,
    runEngine: runEngine as any,
    agentPool: agentPool as any,
    liveChildren,
    operationGate,
    events: { checkpoint: () => 7, publishSince: broadcastSince },
  });
  return { service, store, runEngine, agentPool, liveChildren, operationGate, broadcastSince };
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
    const { service, store, runEngine, agentPool, liveChildren } = createService({
      live: true,
      input,
      run,
      owningRun: run,
    });
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

  it("accepts an active child steer owned by a transcript message in the current run", async () => {
    const input = {
      id: "live-input",
      sessionId: "s1",
      delivery: "steer",
      content: "follow up",
      metadata: {},
    };
    const run = { id: "live-run", sessionId: "s1", inputId: "primary-input", status: "running" };
    const { service, store } = createService({ live: true, input, run, owningRun: run });
    store.getInput.mockReturnValueOnce(undefined).mockReturnValue(input);

    await expect(service.admitPrompt("s1", {
      id: "live-input",
      content: "follow up",
      delivery: "steer",
    })).resolves.toMatchObject({ input, run, queue_state: "running" });
    expect(store.findRunByInput).toHaveBeenCalledWith("live-input");
  });

  it("rejects a live child receipt whose projected input belongs to another run", async () => {
    const input = {
      id: "live-input",
      sessionId: "s1",
      delivery: "steer",
      content: "follow up",
      metadata: {},
    };
    const run = { id: "live-run", sessionId: "s1", inputId: "primary-input", status: "running" };
    const owningRun = { ...run, id: "other-run" };
    const { service, store } = createService({ live: true, input, run, owningRun });
    store.getInput.mockReturnValueOnce(undefined).mockReturnValue(input);

    await expect(service.admitPrompt("s1", {
      id: "live-input",
      content: "follow up",
      delivery: "steer",
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
      metadata: { runtime: { permissionMode: "plan" } },
    })).rejects.toEqual(expect.objectContaining<Partial<SessionApplicationError>>({
      status: 409,
    }));
    expect(store.updateSession).not.toHaveBeenCalled();
    expect(agentPool.close).not.toHaveBeenCalled();
  });

  it("closes the runtime after changing runtime metadata", async () => {
    const { service, store, agentPool, broadcastSince } = createService();

    await service.updateSession("s1", { metadata: { runtime: { permissionMode: "plan" } } });

    expect(store.updateSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      metadata: { runtime: { model: "gpt-test", permissionMode: "plan" } },
    }));
    expect(agentPool.close).toHaveBeenCalledWith("s1");
    expect(broadcastSince).toHaveBeenCalledWith(7);
  });

  it("closes the runtime after changing the model", async () => {
    const { service, store, agentPool } = createService();

    await service.updateSession("s1", { metadata: { runtime: { model: "next-model" } } });

    expect(store.updateSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      model: "next-model",
      metadata: { runtime: { model: "next-model" } },
    }));
    expect(agentPool.close).toHaveBeenCalledWith("s1");
  });

  it("routes attachment prompts to the durable run engine instead of a live child", async () => {
    const { service, runEngine, liveChildren } = createService({ live: true });

    await service.admitPrompt("s1", {
      id: "file-input",
      content: "inspect",
      delivery: "steer",
      attachments: [{ assetId: "att-1" }],
    });

    expect(liveChildren.send).not.toHaveBeenCalled();
    expect(runEngine.admitPromptAndMaybeRun).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        id: "file-input",
        attachments: [{ assetId: "att-1" }],
      }),
    );
  });

  it("blocks prompt admission until a runtime configuration change has closed the old agent", async () => {
    const { service, agentPool, runEngine } = createService();
    let finishClose!: () => void;
    const closing = new Promise<void>((resolve) => { finishClose = resolve; });
    agentPool.close.mockReturnValue(closing);

    const updating = service.updateSession("s1", { metadata: { runtime: { model: "next-model" } } });
    await expect(service.admitPrompt("s1", { content: "too early" })).rejects.toEqual(
      expect.objectContaining<Partial<SessionApplicationError>>({ status: 409 }),
    );
    expect(runEngine.admitPromptAndMaybeRun).not.toHaveBeenCalled();

    finishClose();
    await updating;
    await expect(service.admitPrompt("s1", { content: "now" })).resolves.toBeDefined();
  });

  it("does not warm a session through an active global mutation barrier", () => {
    const { service, agentPool, operationGate } = createService();
    const lease = operationGate.tryEnterBarrier({ kind: "global" }, () => true)!;

    service.getSession("s1", { warm: true });

    expect(agentPool.warm).not.toHaveBeenCalled();
    lease.release();
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

  it("closes child admission before taking the archive descendant snapshot", async () => {
    const { service, store } = createService();
    let closing = false;
    store.beginArchive.mockImplementation(() => {
      closing = true;
      return { ...session, status: "closing" };
    });
    store.listChildSessions.mockImplementation(() => {
      expect(closing).toBe(true);
      return [];
    });

    await service.archiveSessionTree("s1");

    expect(store.beginArchive.mock.invocationCallOrder[0])
      .toBeLessThan(store.listChildSessions.mock.invocationCallOrder[0]!);
  });
});
