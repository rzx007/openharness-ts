import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWorkflowPlan,
  createWorkflowRunSnapshot,
  type WorkflowTaskRunResult,
} from "./workflow-scheduler.js";
import { resumePersistentWorkflow, runPersistentWorkflow, WorkflowRunStore } from "./workflow-store.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "oh-workflow-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("WorkflowRunStore", () => {
  it("persists running snapshots before the workflow completes", async () => {
    const store = new WorkflowRunStore({ dir: tempDir() });
    let unblock: (() => void) | undefined;

    const workflow = runPersistentWorkflow(
      {
        mode: "parallel",
        tasks: [{ id: "research" }],
      },
      async () => {
        await new Promise<void>((resolve) => {
          unblock = resolve;
        });
        return { summary: "research done" };
      },
      { store, runId: "run-progress" },
    );

    await vi.waitFor(() => {
      const snapshot = store.load("run-progress");
      expect(snapshot?.status).toBe("running");
      expect(snapshot?.runningTaskIds).toEqual(["research"]);
      expect(snapshot?.pendingTaskIds).toEqual([]);
    });

    unblock?.();
    const result = await workflow;
    expect(result.status).toBe("completed");
  });

  it("loads and lists completed workflow snapshots", async () => {
    const store = new WorkflowRunStore({ dir: tempDir() });

    const result = await runPersistentWorkflow(
      {
        mode: "pipeline",
        tasks: [{ id: "research" }, { id: "verify" }],
      },
      ({ task }) => ({
        summary: `${task.id} done`,
        result: `${task.id} result`,
        metadata: { task: task.id },
      }),
      { store, runId: "run-complete" },
    );

    expect(result.runId).toBe("run-complete");
    const snapshot = store.load("run-complete");
    expect(snapshot).toMatchObject({
      version: 1,
      runId: "run-complete",
      status: "completed",
      summary: "2/2 tasks completed",
      pendingTaskIds: [],
      runningTaskIds: [],
      plan: { mode: "pipeline", maxConcurrency: 1 },
    });
    expect(snapshot?.orderedResults.map((task) => task.taskId)).toEqual(["research", "verify"]);
    expect(snapshot?.results.verify?.result).toBe("verify result");
    expect(store.list().map((item) => item.runId)).toEqual(["run-complete"]);
  });

  it("rejects unsafe run ids", () => {
    const store = new WorkflowRunStore({ dir: tempDir() });
    expect(() => store.pathFor("../oops")).toThrow("Invalid workflow run id");
  });

  it("resumes a running snapshot without rerunning completed tasks", async () => {
    const store = new WorkflowRunStore({ dir: tempDir() });
    const spec = {
      mode: "pipeline" as const,
      tasks: [{ id: "research" }, { id: "implement" }, { id: "verify" }],
    };
    const plan = createWorkflowPlan(spec);
    const researchResult: WorkflowTaskRunResult = {
      taskId: "research",
      status: "completed",
      summary: "research done",
      result: "research result",
      attempts: 1,
      dependencies: [],
      startedAt: 1,
      finishedAt: 2,
    };
    store.save(createWorkflowRunSnapshot({
      runId: "run-resume",
      status: "running",
      summary: "resume point",
      spec,
      plan,
      results: new Map([["research", researchResult]]),
      running: new Set(["implement"]),
      runningTasks: new Map([[
        "implement",
        {
          taskId: "implement",
          attempt: 1,
          dependencies: ["research"],
          startedAt: 3,
          summary: "Waiting for task task_implement",
          metadata: { taskManagerTaskId: "task_implement" },
        },
      ]]),
      createdAt: 100,
    }));

    const executed: string[] = [];
    const result = await resumePersistentWorkflow(
      "run-resume",
      ({ task, pipelineInput, resumeFrom }) => {
        executed.push(task.id);
        if (task.id === "implement") {
          expect(pipelineInput?.taskId).toBe("research");
          expect(resumeFrom?.metadata?.taskManagerTaskId).toBe("task_implement");
        }
        if (task.id === "verify") {
          expect(pipelineInput?.taskId).toBe("implement");
        }
        return { summary: `${task.id} done`, result: `${task.id} result` };
      },
      { store },
    );

    expect(executed).toEqual(["implement", "verify"]);
    expect(result.runId).toBe("run-resume");
    expect(result.results.research).toEqual(researchResult);
    expect(result.results.implement?.status).toBe("completed");
    expect(result.results.verify?.status).toBe("completed");

    const snapshot = store.load("run-resume");
    expect(snapshot).toMatchObject({
      status: "completed",
      summary: "3/3 tasks completed",
      createdAt: 100,
      pendingTaskIds: [],
      runningTaskIds: [],
    });
    expect(snapshot?.orderedResults.map((task) => task.taskId)).toEqual(["research", "implement", "verify"]);
  });

  it("returns terminal snapshots without rerunning workers", async () => {
    const store = new WorkflowRunStore({ dir: tempDir() });
    await runPersistentWorkflow(
      { mode: "parallel", tasks: [{ id: "done" }] },
      () => ({ summary: "done" }),
      { store, runId: "terminal" },
    );

    const result = await resumePersistentWorkflow(
      "terminal",
      () => {
        throw new Error("should not run");
      },
      { store },
    );

    expect(result.status).toBe("completed");
    expect(result.orderedResults.map((task) => task.taskId)).toEqual(["done"]);
  });
});
