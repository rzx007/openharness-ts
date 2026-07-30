import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkflowPlan,
  createWorkflowRunSnapshot,
  parseWorkflowNotification,
  WorkflowRunStore,
  type WorkflowRunner,
  type WorkflowSpec,
  type WorkflowTaskRunResult,
} from "@openharness/coordinator";
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

  it("passes scheduling hints into workflow specs", async () => {
    const runner: WorkflowRunner = vi.fn(async ({ task }) => ({ summary: `${task.id} done` }));
    const run = vi.fn(async (spec: WorkflowSpec) => ({
      status: "completed" as const,
      summary: "2/2 tasks completed",
      plan: {
        mode: spec.mode,
        tasks: spec.tasks,
        maxConcurrency: 2,
        defaultTaskTimeoutMs: spec.defaultTaskTimeoutMs,
        executionOrder: spec.tasks.map((task) => task.id),
        dependencyMap: Object.fromEntries(spec.tasks.map((task) => [task.id, task.dependsOn ?? []])),
        dependentsMap: Object.fromEntries(spec.tasks.map((task) => [task.id, []])),
      },
      results: {},
      orderedResults: [],
    }));

    const tool = createWorkflowTool({ createRunner: () => runner, run });
    await tool.execute(
      {
        mode: "parallel",
        budgetPreset: "safe-write",
        defaultTaskTimeoutSeconds: 30,
        budgetPolicy: {
          maxTokensUsed: 1_000,
          maxTimeUsedSeconds: 60,
          softMaxTokensUsed: 800,
          softMaxTimeUsedSeconds: 45,
          onSoftLimit: "serialize-and-conserve",
          conserve: { promptHint: "stay tiny", permissionMode: "plan", maxTurns: 4 },
        },
        tasks: [
          { id: "write", writeScope: ["packages/auth"], isolate: false, timeoutSeconds: 10 },
          { id: "read", readOnly: true, writeScope: ["packages/auth"] },
        ],
      },
      ctx,
    );

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultTaskTimeoutMs: 30_000,
        budgetPolicyPreset: "safe-write",
        budgetPolicy: {
          maxTokensUsed: 1_000,
          maxTimeUsedMs: 60_000,
          softMaxTokensUsed: 800,
          softMaxTimeUsedMs: 45_000,
          onSoftLimit: "serialize-and-conserve",
          conserve: { promptHint: "stay tiny", permissionMode: "plan", maxTurns: 4 },
        },
        tasks: [
          expect.objectContaining({ id: "write", writeScope: ["packages/auth"], isolate: false, timeoutMs: 10_000 }),
          expect.objectContaining({ id: "read", readOnly: true, writeScope: ["packages/auth"] }),
        ],
      }),
      runner,
    );
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

  it("returns persisted workflow status snapshots", async () => {
    const cwd = makeTempDir();
    try {
      const store = new WorkflowRunStore({ cwd });
      const spec = { mode: "parallel" as const, tasks: [{ id: "research" }] };
      store.save(createWorkflowRunSnapshot({
        runId: "status-run",
        status: "running",
        summary: "1 task running",
        spec,
        plan: createWorkflowPlan(spec),
        results: new Map(),
        running: new Set(["research"]),
        createdAt: 1,
      }));
      store.appendEvent({
        version: 1,
        runId: "status-run",
        type: "workflow_started",
        timestamp: 2,
        summary: "Workflow started",
      });
      store.appendEvent({
        version: 1,
        runId: "status-run",
        type: "task_started",
        timestamp: 3,
        taskId: "research",
        status: "running",
        summary: "Task running",
      });
      store.appendEvent({
        version: 1,
        runId: "status-run",
        type: "task_finished",
        timestamp: 4,
        taskId: "other",
        status: "completed",
        summary: "Other done",
      });

      const tool = createWorkflowTool({ createRunner: vi.fn() });
      const result = await tool.execute({ action: "status", runId: "status-run" }, { cwd });

      expect(result.isError).toBeUndefined();
      expect(textOf(result)).toContain("<workflow-run-snapshot>");
      expect(textOf(result)).toContain("status-run");
      expect(textOf(result)).toContain("research");
      expect(textOf(result)).toContain("workflow_started");
      expect(textOf(result)).toContain("timelineControls");
      expect(textOf(result)).toContain("timelineSummary");
      expect(textOf(result)).toContain("available");
      expect(textOf(result)).toContain("selected");

      const timelineResult = await tool.execute({ action: "status", runId: "status-run", view: "timeline" }, { cwd });
      expect(textOf(timelineResult)).toContain("Workflow status-run (running)");
      expect(textOf(timelineResult)).toContain("workflow_started");

      const filteredTimeline = await tool.execute({
        action: "status",
        runId: "status-run",
        view: "timeline",
        taskIds: ["research"],
        eventTypes: ["task_started"],
        statuses: ["running"],
      }, { cwd });
      expect(textOf(filteredTimeline)).toContain("Filters: taskIds=research eventTypes=task_started statuses=running");
      expect(textOf(filteredTimeline)).toContain("task_started research [running]");
      expect(textOf(filteredTimeline)).not.toContain("workflow_started");
      expect(textOf(filteredTimeline)).not.toContain("Other done");

      const filteredSnapshot = await tool.execute({
        action: "status",
        runId: "status-run",
        taskIds: ["research"],
        eventTypes: ["task_started"],
        statuses: ["running"],
      }, { cwd });
      expect(textOf(filteredSnapshot)).toContain('"selected":{"taskIds":["research"],"eventTypes":["task_started"],"statuses":["running"]}');
      expect(textOf(filteredSnapshot)).toContain('"eventTypes":["task_finished","task_started","workflow_started"]');
      expect(textOf(filteredSnapshot)).not.toContain("Other done");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("lists persisted workflow run summaries", async () => {
    const cwd = makeTempDir();
    try {
      const store = new WorkflowRunStore({ cwd });
      const completedSpec = { mode: "parallel" as const, tasks: [{ id: "done" }] };
      const runningSpec = { mode: "pipeline" as const, budgetPolicyPreset: "safe-write" as const, tasks: [{ id: "research" }, { id: "write" }] };
      const conflictSpec = {
        mode: "parallel" as const,
        budgetPolicyPreset: "safe-write" as const,
        tasks: [
          { id: "auth-a", writeScope: ["packages/auth"] },
          { id: "auth-b", writeScope: ["packages/auth/src"] },
        ],
      };
      const doneResult: WorkflowTaskRunResult = {
        taskId: "done",
        status: "completed",
        summary: "done",
        attempts: 1,
        dependencies: [],
        startedAt: 1,
        finishedAt: 2,
      };
      const conflictResults = new Map<string, WorkflowTaskRunResult>([
        ["auth-a", {
          taskId: "auth-a",
          status: "completed",
          summary: "auth-a done",
          attempts: 1,
          dependencies: [],
          startedAt: 1,
          finishedAt: 2,
        }],
        ["auth-b", {
          taskId: "auth-b",
          status: "completed",
          summary: "auth-b done",
          attempts: 1,
          dependencies: [],
          startedAt: 3,
          finishedAt: 4,
        }],
      ]);
      store.save(createWorkflowRunSnapshot({
        runId: "completed-run",
        status: "completed",
        summary: "1/1 tasks completed",
        spec: completedSpec,
        plan: createWorkflowPlan(completedSpec),
        results: new Map([["done", doneResult]]),
        running: new Set(),
        createdAt: 1,
      }));
      store.save(createWorkflowRunSnapshot({
        runId: "running-run",
        status: "running",
        summary: "1 task running",
        spec: runningSpec,
        plan: createWorkflowPlan(runningSpec),
        results: new Map(),
        running: new Set(["research"]),
        createdAt: 2,
      }));
      store.save(createWorkflowRunSnapshot({
        runId: "conflict-run",
        status: "completed",
        summary: "2/2 tasks completed",
        spec: conflictSpec,
        plan: createWorkflowPlan(conflictSpec),
        results: conflictResults,
        running: new Set(),
        createdAt: 3,
      }));

      const tool = createWorkflowTool({ createRunner: vi.fn() });
      const result = await tool.execute({
        action: "list",
        runIdPrefix: "conflict",
        createdAfter: 3,
        needsReconciliation: true,
        budgetPreset: "safe-write",
        limit: 1,
      }, { cwd });

      expect(result.isError).toBeUndefined();
      expect(textOf(result)).toContain("<workflow-run-list>");
      expect(textOf(result)).toContain('"runId":"conflict-run"');
      expect(textOf(result)).toContain('"budgetPolicyPreset":"safe-write"');
      expect(textOf(result)).toContain('"needsReconciliation":true');
      expect(textOf(result)).not.toContain("completed-run");
      expect(textOf(result)).not.toContain("running-run");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("returns built-in workflow templates", async () => {
    const tool = createWorkflowTool({ createRunner: vi.fn() });
    const result = await tool.execute({
      action: "template",
      templateName: "research-implement-verify",
      templateParameters: {
        taskPrompts: { implement: "Patch exactly these files" },
        writeScope: ["packages/tools"],
        maxConcurrency: 2,
        budgetPreset: "fast-parallel",
      },
    }, ctx);

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("<workflow-templates>");
    expect(textOf(result)).toContain('"name":"research-implement-verify"');
    expect(textOf(result)).toContain('"mode":"pipeline"');
    expect(textOf(result)).toContain('"budgetPolicyPreset":"fast-parallel"');
    expect(textOf(result)).toContain('"maxConcurrency":2');
    expect(textOf(result)).toContain('"prompt":"Patch exactly these files"');
    expect(textOf(result)).toContain('"writeScope":["packages/tools"]');
    expect(textOf(result)).not.toContain('"name":"parallel-review"');
  });

  it("creates a reconciliation follow-up workflow spec for a persisted run", async () => {
    const cwd = makeTempDir();
    try {
      const store = new WorkflowRunStore({ cwd });
      const spec = {
        mode: "parallel" as const,
        tasks: [
          { id: "auth-a", writeScope: ["packages/auth"] },
          { id: "auth-b", writeScope: ["packages/auth/src"] },
        ],
      };
      const results = new Map<string, WorkflowTaskRunResult>([
        ["auth-a", {
          taskId: "auth-a",
          status: "completed",
          summary: "auth-a done",
          metadata: { changedFiles: ["packages/auth/src/index.ts"] },
          attempts: 1,
          dependencies: [],
          startedAt: 1,
          finishedAt: 2,
        }],
        ["auth-b", {
          taskId: "auth-b",
          status: "completed",
          summary: "auth-b done",
          metadata: { changedFiles: ["packages/auth/src/index.ts"] },
          attempts: 1,
          dependencies: [],
          startedAt: 3,
          finishedAt: 4,
        }],
      ]);
      store.save(createWorkflowRunSnapshot({
        runId: "reconcile-source",
        status: "completed",
        summary: "2/2 tasks completed",
        spec,
        plan: createWorkflowPlan(spec),
        results,
        running: new Set(),
        createdAt: 1,
      }));

      const tool = createWorkflowTool({ createRunner: vi.fn() });
      const result = await tool.execute({ action: "reconcile", runId: "reconcile-source", budgetPreset: "cheap-review" }, { cwd });

      expect(result.isError).toBeUndefined();
      expect(textOf(result)).toContain("<workflow-reconcile-spec>");
      expect(textOf(result)).toContain('"sourceRunId":"reconcile-source"');
      expect(textOf(result)).toContain('"budgetPolicyPreset":"cheap-review"');
      expect(textOf(result)).toContain('"id":"reconcile-reconcile-actual-auth-a-auth-b"');
      expect(textOf(result)).toContain('"id":"verify-reconciliation"');
      expect(textOf(result)).toContain('"writeScope":["packages/auth/src/index.ts"]');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("resumes persisted workflow snapshots through the tool", async () => {
    const cwd = makeTempDir();
    try {
      const store = new WorkflowRunStore({ cwd });
      const spec = {
        mode: "pipeline" as const,
        tasks: [{ id: "research" }, { id: "implement" }, { id: "verify" }],
      };
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
        runId: "resume-run",
        status: "running",
        summary: "resume point",
        spec,
        plan: createWorkflowPlan(spec),
        results: new Map([["research", researchResult]]),
        running: new Set(["implement"]),
        createdAt: 1,
      }));

      const executed: string[] = [];
      const runner: WorkflowRunner = vi.fn(({ task }) => {
        executed.push(task.id);
        return { summary: `${task.id} done`, result: `${task.id} result` };
      });
      const tool = createWorkflowTool({ createRunner: () => runner });
      const result = await tool.execute({ action: "resume", runId: "resume-run" }, { cwd });

      expect(result.isError).toBeUndefined();
      expect(executed).toEqual(["implement", "verify"]);
      const notification = parseWorkflowNotification(textOf(result));
      expect(notification).toMatchObject({
        runId: "resume-run",
        status: "completed",
        summary: "3/3 tasks completed",
      });
      expect(notification?.tasks.map((task) => task.taskId)).toEqual(["research", "implement", "verify"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

function textOf(result: Awaited<ReturnType<ReturnType<typeof createWorkflowTool>["execute"]>>): string {
  const block = result.content[0];
  return block && "text" in block ? String(block.text) : "";
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "oh-workflow-tool-"));
}
