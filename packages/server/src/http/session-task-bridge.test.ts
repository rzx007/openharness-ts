import { describe, expect, it, vi } from "vitest";

import { SessionTaskBridgeManager, type TaskManager } from "./session-task-bridge.js";

function createContext() {
  return {
    store: {
      createSessionTask: vi.fn(),
      findSessionTaskByManagerTaskId: vi.fn(),
      getSessionTask: vi.fn(),
      updateSessionTask: vi.fn(),
    },
    getTaskManager: vi.fn(() => createTaskManager()),
    events: { checkpoint: vi.fn(() => 4), publishSince: vi.fn() },
    traceIdForRun: vi.fn((runId: string) => `trace-${runId}`),
    log: vi.fn(),
  };
}

function createTaskManager(overrides: Partial<TaskManager> = {}): TaskManager {
  return {
    beginSessionTask: vi.fn(),
    completeSessionTask: vi.fn(),
    listTasks: vi.fn(() => []),
    readTaskOutput: vi.fn(() => "output"),
    registerSessionTask: vi.fn(),
    registerTaskListener: vi.fn(),
    writeToTask: vi.fn(),
    ...overrides,
  };
}

describe("SessionTaskBridgeManager", () => {
  it("does not register a live task when durable task creation fails", () => {
    const context = createContext();
    const manager = createTaskManager();
    context.getTaskManager.mockReturnValue(manager);
    context.store.createSessionTask.mockImplementation(() => { throw new Error("store unavailable"); });
    const bridge = new SessionTaskBridgeManager(context).createBridge({ id: "s1", cwd: "/repo" });

    expect(() => bridge.registerSessionTask(childTaskInput())).toThrow("store unavailable");
    expect(manager.registerSessionTask).not.toHaveBeenCalled();
  });

  it("marks the durable task failed when live task registration fails", () => {
    const context = createContext();
    const manager = createTaskManager({
      registerSessionTask: vi.fn(() => { throw new Error("manager unavailable"); }),
    });
    context.getTaskManager.mockReturnValue(manager);
    const bridge = new SessionTaskBridgeManager(context).createBridge({ id: "s1", cwd: "/repo" });

    expect(() => bridge.registerSessionTask(childTaskInput())).toThrow("manager unavailable");
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
      completeSessionTask: vi.fn(async () => { throw new Error("manager unavailable"); }),
    });
    context.getTaskManager.mockReturnValue(manager);
    context.store.updateSessionTask.mockReturnValue({ sessionId: "s1" });
    context.store.getSessionTask.mockReturnValue({ id: "task-1", sessionId: "s1", runId: "run-1" });
    const bridge = new SessionTaskBridgeManager(context).createBridge({ id: "s1", cwd: "/repo" });

    await expect(bridge.completeSessionTask("task-1", { status: "completed", output: "done" })).resolves.toBeUndefined();
    expect(context.store.updateSessionTask).toHaveBeenCalledWith("task-1", {
      status: "completed",
      output: "done",
    });
    expect(context.log).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn",
      event: "session.task.manager_completion_failed",
      error: "manager unavailable",
    }));
  });

  it("moves both live and durable task state back to running when a child starts another run", async () => {
    const context = createContext();
    const manager = createTaskManager();
    context.getTaskManager.mockReturnValue(manager);
    context.store.updateSessionTask.mockReturnValue({ sessionId: "s1" });
    const bridge = new SessionTaskBridgeManager(context).createBridge({ id: "s1", cwd: "/repo" });

    await bridge.bindSessionTaskRun("task-1", "run-2");

    expect(manager.beginSessionTask).toHaveBeenCalledWith("task-1");
    expect(context.store.updateSessionTask).toHaveBeenCalledWith("task-1", {
      status: "running",
      runId: "run-2",
    });
  });

  it("projects task manager tasks into durable session tasks", () => {
    const context = createContext();
    const manager = createTaskManager({
      listTasks: vi.fn(() => [{
        id: "task-1",
        type: "shell",
        status: "running",
        description: "npm test",
        cwd: "/repo",
        metadata: { child_session_id: "child-1" },
      }]),
    });
    context.store.findSessionTaskByManagerTaskId
      .mockReturnValueOnce(undefined)
      .mockReturnValue({ id: "task-1", sessionId: "s1" });
    context.store.getSessionTask.mockReturnValue(undefined);
    const bridge = new SessionTaskBridgeManager(context);

    bridge.projectManagerTasks("s1", manager);

    expect(context.store.createSessionTask).toHaveBeenCalledWith({
      id: "task-1",
      sessionId: "s1",
      childSessionId: "child-1",
      type: "shell",
      description: "npm test",
      cwd: "/repo",
      metadata: { origin: "task_manager", taskManagerId: "task-1" },
    });
    expect(context.store.updateSessionTask).toHaveBeenCalledWith("task-1", {
      status: "running",
      output: "output",
    });
    expect(context.events.publishSince).toHaveBeenCalledWith(4);
  });

  it("syncs failed task output into durable state", () => {
    const context = createContext();
    const manager = createTaskManager({
      readTaskOutput: vi.fn(() => "boom"),
    });
    const bridge = new SessionTaskBridgeManager(context);

    bridge.syncPersistentTask({
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
