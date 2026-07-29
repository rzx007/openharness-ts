import { describe, expect, it, vi } from "vitest";
import { parseWorkflowNotification, type WorkflowRunner, type WorkflowSpec } from "@openharness/coordinator";
import { createWorkflowTool } from "./workflow";
import type { AgentWorkflowRunnerOptions } from "./workflow-runner";

const ctx = { cwd: "/work" };

describe("workflowTool", () => {
  it("passes parsed workflow specs to the scheduler and formats successful results", async () => {
    const runner: WorkflowRunner = vi.fn(async ({ task }) => ({
      summary: `ran ${task.id}`,
      result: `result ${task.id}`,
    }));
    const createRunner = vi.fn((_options: AgentWorkflowRunnerOptions) => runner);
    const run = vi.fn(async (spec: WorkflowSpec, workflowRunner: WorkflowRunner) => {
      const worker = await workflowRunner({
        task: spec.tasks[0]!,
        attempt: 1,
        dependencyResults: {},
      });
      return {
        status: "completed" as const,
        summary: "1/1 tasks completed",
        plan: {
          mode: spec.mode,
          tasks: spec.tasks,
          maxConcurrency: spec.maxConcurrency ?? Number.POSITIVE_INFINITY,
          executionOrder: spec.tasks.map((task) => task.id),
          dependencyMap: Object.fromEntries(spec.tasks.map((task) => [task.id, task.dependsOn ?? []])),
          dependentsMap: Object.fromEntries(spec.tasks.map((task) => [task.id, []])),
        },
        results: {
          build: {
            taskId: "build",
            status: worker.status ?? "completed",
            summary: worker.summary,
            result: worker.result,
            attempts: 1,
            dependencies: [],
            startedAt: 1,
            finishedAt: 2,
          },
        },
        orderedResults: [
          {
            taskId: "build",
            status: worker.status ?? "completed",
            summary: worker.summary,
            result: worker.result,
            attempts: 1,
            dependencies: [],
            startedAt: 1,
            finishedAt: 2,
          },
        ],
      };
    });

    const tool = createWorkflowTool({ createRunner, run });
    const result = await tool.execute(
      {
        mode: "parallel",
        maxConcurrency: 2,
        failurePolicy: "skip-dependents",
        team: "alpha",
        timeoutSeconds: 10,
        permissionMode: "plan",
        tasks: [{ id: "build", description: "Build it", prompt: "please build", dependsOn: [] }],
      },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(createRunner).toHaveBeenCalledWith({
      cwd: "/work",
      team: "alpha",
      timeoutMs: 10000,
      permissionMode: "plan",
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "parallel",
        maxConcurrency: 2,
        failurePolicy: "skip-dependents",
        tasks: [expect.objectContaining({ id: "build", prompt: "please build" })],
      }),
      runner,
    );
    const notification = parseWorkflowNotification(textOf(result));
    expect(notification).toMatchObject({
      status: "completed",
      summary: "1/1 tasks completed",
      mode: "parallel",
      totalTasks: 1,
      completedTasks: 1,
      failedTasks: 0,
    });
    expect(notification?.tasks[0]).toMatchObject({
      taskId: "build",
      status: "completed",
      summary: "ran build",
      result: "result build",
    });
  });

  it("returns an error for invalid workflow input", async () => {
    const createRunner = vi.fn();
    const tool = createWorkflowTool({ createRunner });

    const result = await tool.execute({ mode: "parallel", tasks: [] }, ctx);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("tasks must be a non-empty array");
    expect(createRunner).not.toHaveBeenCalled();
  });

  it("marks failed workflow results as tool errors", async () => {
    const runner: WorkflowRunner = vi.fn();
    const tool = createWorkflowTool({
      createRunner: () => runner,
      run: async (spec) => ({
        status: "failed",
        summary: "0/1 tasks completed",
        plan: {
          mode: spec.mode,
          tasks: spec.tasks,
          maxConcurrency: 1,
          executionOrder: ["test"],
          dependencyMap: { test: [] },
          dependentsMap: { test: [] },
        },
        results: {
          test: {
            taskId: "test",
            status: "failed",
            summary: "boom",
            attempts: 1,
            dependencies: [],
            startedAt: 1,
            finishedAt: 2,
          },
        },
        orderedResults: [
          {
            taskId: "test",
            status: "failed",
            summary: "boom",
            attempts: 1,
            dependencies: [],
            startedAt: 1,
            finishedAt: 2,
          },
        ],
      }),
    });

    const result = await tool.execute({ mode: "parallel", tasks: [{ id: "test" }] }, ctx);

    expect(result.isError).toBe(true);
    const notification = parseWorkflowNotification(textOf(result));
    expect(notification?.status).toBe("failed");
    expect(notification?.tasks[0]).toMatchObject({
      taskId: "test",
      status: "failed",
      summary: "boom",
    });
  });
});

function textOf(result: Awaited<ReturnType<ReturnType<typeof createWorkflowTool>["execute"]>>): string {
  const block = result.content[0];
  return block && "text" in block ? String(block.text) : "";
}
