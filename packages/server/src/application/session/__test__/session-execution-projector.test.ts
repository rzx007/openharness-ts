import { describe, expect, it, vi } from "vitest";

import { SessionExecutionProjector, type ChildAgentRegistry, type DetachedProcessRuntime } from "../session-execution-projector.js";

function createContext() {
  return {
    store: {
      createSessionTask: vi.fn(),
      findSessionExecutionByRuntimeId: vi.fn(),
      getSessionTask: vi.fn(),
      updateSessionTask: vi.fn(),
    },
    getChildAgentExecutionRegistry: vi.fn(() => createTaskManager()),
    events: { checkpoint: vi.fn(() => 4), publishSince: vi.fn() },
    traceIdForRun: vi.fn((runId: string) => `trace-${runId}`),
    log: vi.fn(),
  };
}

function createTaskManager(overrides: Partial<ChildAgentRegistry & DetachedProcessRuntime> = {}): ChildAgentRegistry & DetachedProcessRuntime {
  return {
    beginExecution: vi.fn(),
    completeExecution: vi.fn(),
    listExecutions: vi.fn(() => []),
    readOutput: vi.fn(() => "output"),
    registerChildExecution: vi.fn(),
    registerExecutionListener: vi.fn(),
    ...overrides,
  };
}

describe("SessionExecutionProjector", () => {
  it("does not register a live task when durable task creation fails", () => {
    const context = createContext();
    const manager = createTaskManager();
    context.getChildAgentExecutionRegistry.mockReturnValue(manager);
    context.store.createSessionTask.mockImplementation(() => { throw new Error("store unavailable"); });
    const bridge = new SessionExecutionProjector(context).createBridge({ id: "s1", cwd: "/repo" });

    expect(() => bridge.registerChildExecution(childTaskInput())).toThrow("store unavailable");
    expect(manager.registerChildExecution).not.toHaveBeenCalled();
  });

  it("marks the durable task failed when live task registration fails", () => {
    const context = createContext();
    const manager = createTaskManager({
      registerChildExecution: vi.fn(() => { throw new Error("manager unavailable"); }),
    });
    context.getChildAgentExecutionRegistry.mockReturnValue(manager);
    const bridge = new SessionExecutionProjector(context).createBridge({ id: "s1", cwd: "/repo" });

    expect(() => bridge.registerChildExecution(childTaskInput())).toThrow("manager unavailable");
    expect(context.store.updateSessionTask).toHaveBeenCalledWith("task-1", {
      status: "failed",
      output: "manager unavailable",
      error: "manager unavailable",
    });
    expect(context.events.publishSince).toHaveBeenCalledWith(4);
  });

  it("persists terminal state even when live task completion fails", async () => {
    const context = createContext();
    const manager = createTaskManager({
      completeExecution: vi.fn(async () => { throw new Error("manager unavailable"); }),
    });
    context.getChildAgentExecutionRegistry.mockReturnValue(manager);
    context.store.updateSessionTask.mockReturnValue({ sessionId: "s1" });
    context.store.getSessionTask.mockReturnValue({ id: "task-1", sessionId: "s1", runId: "run-1" });
    const bridge = new SessionExecutionProjector(context).createBridge({ id: "s1", cwd: "/repo" });

    await expect(bridge.completeChildExecution("task-1", { status: "completed", output: "done" })).resolves.toBeUndefined();
    expect(context.store.updateSessionTask).toHaveBeenCalledWith("task-1", {
      status: "completed",
      output: "done",
    });
    expect(context.log).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn",
      event: "session.execution.registry_completion_failed",
      error: "manager unavailable",
    }));
  });

  it("moves both live and durable task state back to running when a child starts another run", async () => {
    const context = createContext();
    const manager = createTaskManager();
    context.getChildAgentExecutionRegistry.mockReturnValue(manager);
    context.store.updateSessionTask.mockReturnValue({ sessionId: "s1" });
    const bridge = new SessionExecutionProjector(context).createBridge({ id: "s1", cwd: "/repo" });

    await bridge.bindChildExecutionRun("task-1", "run-2");

    expect(manager.beginExecution).toHaveBeenCalledWith("task-1");
    expect(context.store.updateSessionTask).toHaveBeenCalledWith("task-1", {
      status: "running",
      runId: "run-2",
    });
  });

  it("projects task manager tasks into durable session tasks", () => {
    const context = createContext();
    const manager = createTaskManager({
      listExecutions: vi.fn(() => [{
        id: "task-1",
        type: "shell",
        status: "running",
        description: "npm test",
        cwd: "/repo",
        metadata: { child_session_id: "child-1" },
      }]),
    });
    context.store.findSessionExecutionByRuntimeId
      .mockReturnValueOnce(undefined)
      .mockReturnValue({ id: "task-1", sessionId: "s1" });
    context.store.getSessionTask.mockReturnValue(undefined);
    const bridge = new SessionExecutionProjector(context);

    bridge.projectProcessExecutions("s1", manager);

    expect(context.store.createSessionTask).toHaveBeenCalledWith({
      id: "task-1",
      sessionId: "s1",
      childSessionId: "child-1",
      type: "shell",
      description: "npm test",
      cwd: "/repo",
      metadata: { origin: "detached_process", executionBackend: "detached_process", runtimeExecutionId: "task-1" },
    });
    expect(context.store.updateSessionTask).toHaveBeenCalledWith("task-1", {
      status: "running",
      output: "output",
    });
    expect(context.events.publishSince).toHaveBeenCalledWith(4);
  });

  it("keeps collision-renamed durable tasks synced by their durable id", () => {
    const context = createContext();
    const liveTask = {
      id: "task-1",
      type: "shell",
      status: "running",
      description: "npm test",
      cwd: "/repo",
      metadata: {},
    };
    let listener: ((task: typeof liveTask) => void) | undefined;
    const manager = createTaskManager({
      listExecutions: vi.fn(() => [liveTask]),
      registerExecutionListener: vi.fn((next) => { listener = next as (task: typeof liveTask) => void; }),
    });
    context.store.findSessionExecutionByRuntimeId
      .mockReturnValueOnce(undefined)
      .mockReturnValue({ id: "durable-1", sessionId: "s1" });
    context.store.getSessionTask.mockImplementation((id: string) =>
      id === "task-1"
        ? { id, sessionId: "other", status: "running" }
        : { id, sessionId: "s1", status: "running" });
    const bridge = new SessionExecutionProjector(context);

    bridge.projectProcessExecutions("s1", manager);
    context.store.updateSessionTask.mockClear();
    listener?.({ ...liveTask, status: "completed" });

    expect(context.store.getSessionTask).toHaveBeenLastCalledWith("durable-1");
    expect(context.store.updateSessionTask).toHaveBeenCalledWith("durable-1", {
      status: "completed",
      output: "output",
    });
  });

  it("syncs failed task output into durable state", () => {
    const context = createContext();
    const manager = createTaskManager({
      readOutput: vi.fn(() => "boom"),
    });
    const bridge = new SessionExecutionProjector(context);

    bridge.syncPersistentExecution({
      id: "task-1",
      type: "shell",
      status: "failed",
      description: "npm test",
      cwd: "/repo",
      metadata: {},
    }, manager, "durable-1");

    expect(context.store.updateSessionTask).toHaveBeenCalledWith("durable-1", {
      status: "failed",
      output: "boom",
      error: "boom",
    });
    expect(context.events.publishSince).toHaveBeenCalledWith(4);
  });

  it("does not regress a durable terminal task from a stale live running snapshot", () => {
    const context = createContext();
    context.store.getSessionTask.mockReturnValue({
      id: "task-1",
      sessionId: "s1",
      status: "completed",
    });
    const manager = createTaskManager();
    const bridge = new SessionExecutionProjector(context);

    bridge.syncPersistentExecution({
      id: "task-1",
      type: "agent",
      status: "running",
      description: "Explore",
      cwd: "/repo",
      metadata: {},
    }, manager);

    expect(context.store.updateSessionTask).not.toHaveBeenCalled();
  });
});

function childTaskInput() {
  return {
    id: "task-1",
    description: "Explore",
    cwd: "/repo",
    sessionId: "s1",
    childSessionId: "child-1",
    prompt: "inspect",
    onInput: async () => {},
    onStop: async () => {},
  };
}
