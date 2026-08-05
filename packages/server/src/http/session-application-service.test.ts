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
  const runtimePool = {
    configured: true,
    warm: vi.fn(async () => {}),
    get: vi.fn(),
    close: vi.fn(async () => {}),
    closeForCwd: vi.fn(async () => {}),
    closeAll: vi.fn(async () => {}),
  };
  const broadcastSince = vi.fn();
  const service = new SessionApplicationService({
    store: store as any,
    runEngine: runEngine as any,
    runtimePool: runtimePool as any,
    events: { checkpoint: () => 7, publishSince: broadcastSince },
  });
  return { service, store, runEngine, runtimePool, broadcastSince };
}

describe("SessionApplicationService", () => {
  it("creates a session, starts warming it, and publishes the store event", () => {
    const { service, runtimePool, broadcastSince } = createService();

    const created = service.createSession({ cwd: "/repo", model: "gpt-test" });

    expect(created).toMatchObject({ cwd: "/repo", model: "gpt-test" });
    expect(runtimePool.warm).toHaveBeenCalledWith("s1");
    expect(broadcastSince).toHaveBeenCalledWith(7);
  });

  it("rejects runtime-setting changes while the session has run work", async () => {
    const { service, store, runtimePool } = createService({ hasWork: true });

    await expect(service.updateSession("s1", {
      metadata: { permissionMode: "strict" },
    })).rejects.toEqual(expect.objectContaining<Partial<SessionApplicationError>>({
      status: 409,
    }));
    expect(store.updateSession).not.toHaveBeenCalled();
    expect(runtimePool.close).not.toHaveBeenCalled();
  });

  it("closes the runtime after changing runtime metadata", async () => {
    const { service, store, runtimePool, broadcastSince } = createService();

    await service.updateSession("s1", { metadata: { permissionMode: "strict" } });

    expect(store.updateSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      metadata: { permissionMode: "strict" },
    }));
    expect(runtimePool.close).toHaveBeenCalledWith("s1");
    expect(broadcastSince).toHaveBeenCalledWith(7);
  });

  it("resumes an interrupted run and records its recovery link", () => {
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

    const resumed = service.resumeRun("s1", "source-run", {
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
