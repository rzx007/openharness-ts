import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DetachedProcessSupervisor } from "@openharness/services/executions";

import { BackgroundShellService } from "../background-shell-service.js";

let testConfigDir: string;
let previousConfigDir: string | undefined;

beforeAll(() => {
  previousConfigDir = process.env.OPENHARNESS_CONFIG_DIR;
  testConfigDir = mkdtempSync(join(tmpdir(), "oh-background-shell-config-"));
  process.env.OPENHARNESS_CONFIG_DIR = testConfigDir;
});

afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.OPENHARNESS_CONFIG_DIR;
  else process.env.OPENHARNESS_CONFIG_DIR = previousConfigDir;
  rmSync(testConfigDir, { recursive: true, force: true });
});

function createTaskService() {
  const listeners: Array<(task: any) => void> = [];
  const manager = {
    listExecutions: vi.fn(() => []),
    startShellExecution: vi.fn(async (input) => ({
      id: input.id ?? "manager-task",
      type: "shell",
      status: "running",
      description: input.description,
      cwd: input.cwd,
      metadata: {},
    })),
    getExecution: vi.fn(),
    readOutput: vi.fn(() => "live output"),
    stopExecution: vi.fn(async (taskId) => ({
      id: taskId,
      type: "shell",
      status: "stopped",
      description: "command",
      cwd: "/repo",
      metadata: {},
    })),
    registerExecutionListener: vi.fn((listener) => listeners.push(listener)),
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
  const executionProjector = {
    projectProcessExecutions: vi.fn(),
    trackProcessExecution: vi.fn(),
    syncPersistentExecution: vi.fn(),
  };
  const broadcastSince = vi.fn();
  const service = new BackgroundShellService({
    store: store as any,
    executionProjector: executionProjector as any,
    getDetachedProcessSupervisor: () => manager as any,
    events: { checkpoint: () => 7, publishSince: broadcastSince },
  });
  return { service, store, executionProjector, manager, broadcastSince };
}

describe("BackgroundShellService", () => {
  it("creates a session shell task and its durable projection", async () => {
    const { service, store, executionProjector, broadcastSince } = createTaskService();

    const result = await service.create({ sessionId: "s1", command: "pnpm test" });
    const task = result.execution as { id: string };

    expect(task.id).toMatch(/^task_/);
    expect(store.createSessionTask).toHaveBeenCalledWith(expect.objectContaining({
      id: task.id,
      sessionId: "s1",
      cwd: "/repo",
      metadata: { origin: "http", executionBackend: "detached_process", runtimeExecutionId: task.id },
    }));
    expect(executionProjector.trackProcessExecution).toHaveBeenCalledWith(expect.anything(), task.id);
    expect(executionProjector.syncPersistentExecution).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), expect.anything());
    expect(broadcastSince).toHaveBeenCalledWith(7);
  });

  it("passes tool settings to the process runtime and records the creation origin", async () => {
    const { service, store, manager } = createTaskService();
    const settings = { model: "test-model" } as any;

    const result = await service.create({
      sessionId: "s1",
      command: "pnpm dev",
      settings,
      origin: "tool",
    });

    expect(manager.startShellExecution).toHaveBeenCalledWith(expect.objectContaining({ settings }));
    expect(store.createSessionTask).toHaveBeenCalledWith(expect.objectContaining({
      id: result.execution.id,
      metadata: expect.objectContaining({ origin: "tool" }),
    }));
  });

  it("uses durable output when manager output is unavailable after restart", () => {
    const { service, manager } = createTaskService();
    manager.readOutput.mockImplementation(() => {
      throw new Error("manager task is gone");
    });

    const result = service.get("task-1", { sessionId: "s1" });

    expect(result).toMatchObject({ output: "durable output" });
  });

  it.each(["store", "sync"] as const)(
    "stops a real long-running task when post-spawn %s projection fails",
    async (failurePoint) => {
      const manager = new DetachedProcessSupervisor(mkdtempSync(join(tmpdir(), "oh-session-create-cleanup-")));
      const storeFailure = new Error("store projection failed");
      const syncFailure = new Error("bridge sync failed");
      const store = {
        getSession: vi.fn(() => ({ id: "s1", cwd: process.cwd() })),
        createSessionTask: vi.fn((input) => {
          if (failurePoint === "store") throw storeFailure;
          return { ...input, status: "running", metadata: input.metadata ?? {} };
        }),
      };
      const executionProjector = {
        projectProcessExecutions: vi.fn(),
        trackProcessExecution: vi.fn(),
        syncPersistentExecution: vi.fn(() => {
          if (failurePoint === "sync") throw syncFailure;
        }),
      };
      const service = new BackgroundShellService({
        store: store as any,
        executionProjector: executionProjector as any,
        getDetachedProcessSupervisor: () => manager,
        events: { checkpoint: () => 1, publishSince: vi.fn() },
      });

      try {
        await expect(service.create({
          sessionId: "s1",
          command: `${process.execPath} -e "setInterval(() => {}, 1000)"`,
        })).rejects.toBe(failurePoint === "store" ? storeFailure : syncFailure);

        const [task] = manager.listExecutions();
        expect(task).toBeDefined();
        expect(task?.status).toBe("stopped");
        await expect(manager.awaitExecution(task!.id)).resolves.toMatchObject({ status: "stopped" });
      } finally {
        await manager.aclose().catch(() => {});
      }
    },
  );

  it("keeps the projection error as cause when post-spawn cleanup also fails", async () => {
    const { service, store, manager } = createTaskService();
    const projectionError = new Error("projection failed");
    store.createSessionTask.mockImplementation(() => { throw projectionError; });
    manager.stopExecution.mockRejectedValue(new Error("stop failed"));

    await expect(service.create({ sessionId: "s1", command: "pnpm test" })).rejects.toMatchObject({
      message: expect.stringContaining("projection failed; cleanup failed: stop failed"),
      cause: projectionError,
    });
  });
});
