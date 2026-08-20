import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskManager } from "@openharness/services";

import { SessionTaskService } from "../session-task-service.js";

function createTaskService() {
  const listeners: Array<(task: any) => void> = [];
  const manager = {
    listTasks: vi.fn(() => []),
    createShellTask: vi.fn(async (input) => ({
      id: input.id ?? "manager-task",
      type: "shell",
      status: "running",
      description: input.description,
      cwd: input.cwd,
      metadata: {},
    })),
    getTask: vi.fn(),
    readTaskOutput: vi.fn(() => "live output"),
    stopTask: vi.fn(async (taskId) => ({
      id: taskId,
      type: "shell",
      status: "stopped",
      description: "command",
      cwd: "/repo",
      metadata: {},
    })),
    registerTaskListener: vi.fn((listener) => listeners.push(listener)),
  };
  const durableTask = {
    id: "task-1",
    sessionId: "s1",
    type: "shell",
    status: "running",
    description: "command",
    cwd: "/repo",
    output: "durable output",
    metadata: { taskManagerId: "manager-task" },
  };
  const store = {
    getSession: vi.fn(() => ({ id: "s1", cwd: "/repo" })),
    listSessionTasks: vi.fn(() => [durableTask]),
    getSessionTask: vi.fn(() => durableTask),
    createSessionTask: vi.fn((input) => ({ ...durableTask, ...input })),
  };
  const bridgeManager = {
    projectManagerTasks: vi.fn(),
    trackTask: vi.fn(),
    syncPersistentTask: vi.fn(),
  };
  const broadcastSince = vi.fn();
  const service = new SessionTaskService({
    store: store as any,
    bridgeManager: bridgeManager as any,
    getTaskManager: () => manager as any,
    events: { checkpoint: () => 7, publishSince: broadcastSince },
  });
  return { service, store, bridgeManager, manager, broadcastSince };
}

describe("SessionTaskService", () => {
  it("creates a session shell task and its durable projection", async () => {
    const { service, store, bridgeManager, broadcastSince } = createTaskService();

    const result = await service.create({ sessionId: "s1", command: "pnpm test" });
    const task = result.task as { id: string };

    expect(task.id).toMatch(/^task_/);
    expect(store.createSessionTask).toHaveBeenCalledWith(expect.objectContaining({
      id: task.id,
      sessionId: "s1",
      cwd: "/repo",
      metadata: { origin: "http", taskManagerId: task.id },
    }));
    expect(bridgeManager.trackTask).toHaveBeenCalledWith(expect.anything(), task.id);
    expect(bridgeManager.syncPersistentTask).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), expect.anything());
    expect(broadcastSince).toHaveBeenCalledWith(7);
  });

  it("uses durable output when manager output is unavailable after restart", () => {
    const { service, manager } = createTaskService();
    manager.readTaskOutput.mockImplementation(() => {
      throw new Error("manager task is gone");
    });

    const result = service.get("task-1", { sessionId: "s1" });

    expect(result).toMatchObject({ output: "durable output" });
  });

  it.each(["store", "sync"] as const)(
    "stops a real long-running task when post-spawn %s projection fails",
    async (failurePoint) => {
      const manager = new TaskManager(mkdtempSync(join(tmpdir(), "oh-session-create-cleanup-")));
      const storeFailure = new Error("store projection failed");
      const syncFailure = new Error("bridge sync failed");
      const store = {
        getSession: vi.fn(() => ({ id: "s1", cwd: process.cwd() })),
        createSessionTask: vi.fn((input) => {
          if (failurePoint === "store") throw storeFailure;
          return { ...input, status: "running", metadata: input.metadata ?? {} };
        }),
      };
      const bridgeManager = {
        projectManagerTasks: vi.fn(),
        trackTask: vi.fn(),
        syncPersistentTask: vi.fn(() => {
          if (failurePoint === "sync") throw syncFailure;
        }),
      };
      const service = new SessionTaskService({
        store: store as any,
        bridgeManager: bridgeManager as any,
        getTaskManager: () => manager,
        events: { checkpoint: () => 1, publishSince: vi.fn() },
      });

      try {
        await expect(service.create({
          sessionId: "s1",
          command: `${process.execPath} -e "setInterval(() => {}, 1000)"`,
        })).rejects.toBe(failurePoint === "store" ? storeFailure : syncFailure);

        const [task] = manager.listTasks();
        expect(task).toBeDefined();
        expect(task?.status).toBe("stopped");
        await expect(manager.awaitTask(task!.id)).resolves.toMatchObject({ status: "stopped" });
      } finally {
        await manager.aclose().catch(() => {});
      }
    },
  );

  it("keeps the projection error as cause when post-spawn cleanup also fails", async () => {
    const { service, store, manager } = createTaskService();
    const projectionError = new Error("projection failed");
    store.createSessionTask.mockImplementation(() => { throw projectionError; });
    manager.stopTask.mockRejectedValue(new Error("stop failed"));

    await expect(service.create({ sessionId: "s1", command: "pnpm test" })).rejects.toMatchObject({
      message: expect.stringContaining("projection failed; cleanup failed: stop failed"),
      cause: projectionError,
    });
  });
});
