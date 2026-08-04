import { cloneBudgetUsage, collectWorkflowBudgetUsage } from "./budget.js";
import { collectWorkflowReconciliationIssues, summaryWithReconciliation } from "./reconciliation.js";
import type {
  WorkflowBlockedTask,
  WorkflowPlan,
  WorkflowRunResult,
  WorkflowRunSnapshot,
  WorkflowRunSnapshotPlan,
  WorkflowRunSnapshotStatus,
  WorkflowRunSummary,
  WorkflowRunningTask,
  WorkflowSpec,
  WorkflowTaskRunResult,
} from "./model.js";

export function createWorkflowRunSummary(snapshot: WorkflowRunSnapshot): WorkflowRunSummary {
  const completedTasks = snapshot.orderedResults.filter((task) => task.status === "completed").length;
  const failedTasks = snapshot.orderedResults.length - completedTasks;
  const result = createWorkflowResultFromSnapshot(snapshot);
  return {
    runId: snapshot.runId,
    status: snapshot.status,
    summary: snapshot.summary,
    mode: snapshot.plan.mode,
    totalTasks: snapshot.plan.tasks.length,
    completedTasks,
    failedTasks,
    pendingTasks: snapshot.pendingTaskIds.length,
    runningTasks: snapshot.runningTaskIds.length,
    blockedTasks: snapshot.blockedTaskIds.length,
    needsReconciliation: result.needsReconciliation ?? false,
    budget: snapshot.budget ?? { tasks: {} },
    budgetPolicyPreset: snapshot.plan.budgetPolicyPreset,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  };
}

export function createWorkflowResultFromSnapshot(snapshot: WorkflowRunSnapshot): WorkflowRunResult {
  const maxConcurrency =
    snapshot.plan.maxConcurrency === "unbounded"
      ? Number.POSITIVE_INFINITY
      : snapshot.plan.maxConcurrency;
  const reconciliationIssues = collectWorkflowReconciliationIssues(
    { ...snapshot.plan, maxConcurrency },
    snapshot.orderedResults,
  );
  return {
    runId: snapshot.runId,
    status: snapshot.status === "completed" ? "completed" : "failed",
    summary: summaryWithReconciliation(snapshot.summary, reconciliationIssues),
    plan: {
      ...snapshot.plan,
      maxConcurrency,
    },
    results: snapshot.results,
    orderedResults: snapshot.orderedResults,
    needsReconciliation: reconciliationIssues.length > 0,
    reconciliationIssues,
    budget: snapshot.budget ?? collectWorkflowBudgetUsage(snapshot.orderedResults, Object.values(snapshot.runningTasks ?? {})),
  };
}

export function createWorkflowRunId(now = Date.now()): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `wf-${now.toString(36)}-${rand}`;
}

export function createWorkflowRunSnapshot(input: {
  runId: string;
  status: WorkflowRunSnapshotStatus;
  summary: string;
  spec: WorkflowSpec;
  plan: WorkflowPlan;
  results: Map<string, WorkflowTaskRunResult>;
  running: Set<string>;
  runningTasks?: Map<string, WorkflowRunningTask>;
  blockedTasks?: Map<string, WorkflowBlockedTask>;
  createdAt: number;
}): WorkflowRunSnapshot {
  const orderedResults = input.plan.executionOrder
    .map((taskId) => input.results.get(taskId))
    .filter((result): result is WorkflowTaskRunResult => result !== undefined);
  const terminalTaskIds = new Set(orderedResults.map((result) => result.taskId));
  return {
    version: 1,
    runId: input.runId,
    status: input.status,
    summary: input.summary,
    spec: input.spec,
    plan: snapshotPlan(input.plan),
    results: Object.fromEntries(orderedResults.map((result) => [result.taskId, result])),
    orderedResults,
    pendingTaskIds: input.plan.executionOrder.filter((taskId) => !terminalTaskIds.has(taskId) && !input.running.has(taskId)),
    blockedTaskIds: [...(input.blockedTasks ?? new Map()).keys()],
    blockedTasks: Object.fromEntries(
      [...(input.blockedTasks ?? new Map()).entries()].map(([taskId, task]) => [taskId, {
        ...task,
        waitingForTaskIds: [...task.waitingForTaskIds],
        writeScope: task.writeScope ? [...task.writeScope] : undefined,
        conflictingWriteScope: task.conflictingWriteScope ? [...task.conflictingWriteScope] : undefined,
      }]),
    ),
    runningTaskIds: [...input.running],
    runningTasks: Object.fromEntries(
      [...(input.runningTasks ?? new Map()).entries()].map(([taskId, task]) => [taskId, {
        ...task,
        budget: cloneBudgetUsage(task.budget),
        dependencies: [...task.dependencies],
      }]),
    ),
    budget: collectWorkflowBudgetUsage(orderedResults, [...(input.runningTasks ?? new Map()).values()]),
    createdAt: input.createdAt,
    updatedAt: Date.now(),
  };
}

export function aggregateWorkflowResult(
  runId: string,
  plan: WorkflowPlan,
  results: Map<string, WorkflowTaskRunResult>,
): WorkflowRunResult {
  const orderedResults = plan.executionOrder
    .map((taskId) => results.get(taskId))
    .filter((result): result is WorkflowTaskRunResult => result !== undefined);
  const completed = orderedResults.filter((result) => result.status === "completed").length;
  const failed = orderedResults.length - completed;
  const reconciliationIssues = collectWorkflowReconciliationIssues(plan, orderedResults);
  const baseSummary = `${completed}/${plan.tasks.length} tasks completed`;
  return {
    runId,
    status: failed === 0 ? "completed" : "failed",
    summary: summaryWithReconciliation(baseSummary, reconciliationIssues),
    plan,
    results: Object.fromEntries(orderedResults.map((result) => [result.taskId, result])),
    orderedResults,
    needsReconciliation: reconciliationIssues.length > 0,
    reconciliationIssues,
    budget: collectWorkflowBudgetUsage(orderedResults),
  };
}

function snapshotPlan(plan: WorkflowPlan): WorkflowRunSnapshotPlan {
  return {
    ...plan,
    maxConcurrency: Number.isFinite(plan.maxConcurrency) ? plan.maxConcurrency : "unbounded",
  };
}
