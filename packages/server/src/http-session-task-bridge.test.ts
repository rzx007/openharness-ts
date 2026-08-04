import { describe, expect, it, vi } from "vitest";

import { SessionTaskBridgeManager, type TaskManager } from "./http-session-task-bridge.js";

function createContext() {
  return {
    store: {
      createSessionTask: vi.fn(),
      findSessionTaskByManagerTaskId: vi.fn(),
      getSessionTask: vi.fn(),
      updateSessionTask: vi.fn(),
    },
    getTaskManager: vi.fn(() => createTaskManager()),
    latestEventSeq: vi.fn(() => 4),
    broadcastSince: vi.fn(),
    traceIdForRun: vi.fn((runId: string) => `trace-${runId}`),
    log: vi.fn(),
  };
}

function createTaskManager(overrides: Partial<TaskManager> = {}): TaskManager {
  return {
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
    expect(context.broadcastSince).toHaveBeenCalledWith(4);
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
    expect(context.broadcastSince).toHaveBeenCalledWith(4);
  });
});
