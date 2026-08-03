import { WORKFLOW_BUDGET_POLICY_PRESETS, WORKFLOW_SPEC_TEMPLATES } from "./workflow-model.js";
import {
  cloneBudgetUsage,
  collectWorkflowBudgetUsage,
  workflowBudgetFromMetadata,
  workflowBudgetPolicyExceeded,
  workflowBudgetSoftLimit,
} from "./workflow-budget.js";
import {
  createWorkflowPlan,
  normalizeWriteScope,
  runnableWriteScopes,
  workflowTasksConflict,
  writeScopesOverlap,
} from "./workflow-validation.js";
import type {
  WorkflowMode,
  WorkflowFailurePolicy,
  WorkflowTaskTerminalStatus,
  WorkflowTaskStatus,
  WorkflowRetryPolicy,
  WorkflowTask,
  WorkflowSpec,
  WorkflowPlan,
  WorkflowWorkerResult,
  WorkflowTaskBudgetUsage,
  WorkflowBudgetPolicy,
  WorkflowConservePolicy,
  WorkflowBudgetPolicyPreset,
  WorkflowDiffFileSummary,
  WorkflowDiffSummary,
  WorkflowTaskRunResult,
  WorkflowRunnerContext,
  WorkflowRunner,
  WorkflowRunResult,
  WorkflowRunSummary,
  WorkflowRunSnapshotPlan,
  WorkflowRunningTask,
  WorkflowTaskProgress,
  WorkflowBlockedTask,
  WorkflowReconciliationIssue,
  WorkflowReconciliationFileSummary,
  WorkflowReconciliationTaskSummary,
  WorkflowReconciliationSummary,
  WorkflowReconciliationFollowUpAction,
  WorkflowReconciliationPlan,
  WorkflowReconciliationSpecOptions,
  WorkflowBudgetUsage,
  WorkflowRunSnapshotStatus,
  WorkflowRunSnapshot,
  WorkflowRunOptions,
  WorkflowRunEventType,
  WorkflowRunEvent,
  WorkflowNotificationTask,
  WorkflowNotification,
  WorkflowTemplateName,
  WorkflowSpecTemplate,
  WorkflowValidationIssue,
  WorkflowValidationReport,
} from "./workflow-model.js";

export { WORKFLOW_BUDGET_POLICY_PRESETS, WORKFLOW_SPEC_TEMPLATES } from "./workflow-model.js";
export {
  createWorkflowPlan,
  createWorkflowValidationReport,
  validateWorkflowTasks,
  workflowTasksConflict,
} from "./workflow-validation.js";
export type {
  WorkflowMode,
  WorkflowFailurePolicy,
  WorkflowTaskTerminalStatus,
  WorkflowTaskStatus,
  WorkflowRetryPolicy,
  WorkflowTask,
  WorkflowSpec,
  WorkflowPlan,
  WorkflowWorkerResult,
  WorkflowTaskBudgetUsage,
  WorkflowBudgetPolicy,
  WorkflowConservePolicy,
  WorkflowBudgetPolicyPreset,
  WorkflowDiffFileSummary,
  WorkflowDiffSummary,
  WorkflowTaskRunResult,
  WorkflowRunnerContext,
  WorkflowRunner,
  WorkflowRunResult,
  WorkflowRunSummary,
  WorkflowRunSnapshotPlan,
  WorkflowRunningTask,
  WorkflowTaskProgress,
  WorkflowBlockedTask,
  WorkflowReconciliationIssue,
  WorkflowReconciliationFileSummary,
  WorkflowReconciliationTaskSummary,
  WorkflowReconciliationSummary,
  WorkflowReconciliationFollowUpAction,
  WorkflowReconciliationPlan,
  WorkflowReconciliationSpecOptions,
  WorkflowBudgetUsage,
  WorkflowRunSnapshotStatus,
  WorkflowRunSnapshot,
  WorkflowRunOptions,
  WorkflowRunEventType,
  WorkflowRunEvent,
  WorkflowNotificationTask,
  WorkflowNotification,
  WorkflowTemplateName,
  WorkflowSpecTemplate,
  WorkflowValidationIssue,
  WorkflowValidationReport,
} from "./workflow-model.js";

export function createWorkflowNotification(result: WorkflowRunResult): WorkflowNotification {
  const completedTasks = result.orderedResults.filter((task) => task.status === "completed").length;
  const reconciliationIssues = result.reconciliationIssues ?? [];
  const issueIdsByTask = createReconciliationIssueIdsByTask(reconciliationIssues);
  const reconciliationSummary = createWorkflowReconciliationSummary(reconciliationIssues, result.orderedResults);
  const reconciliationPlan = createWorkflowReconciliationPlan(reconciliationIssues);
  return {
    runId: result.runId,
    status: result.status,
    summary: result.summary,
    mode: result.plan.mode,
    totalTasks: result.plan.tasks.length,
    completedTasks,
    failedTasks: result.orderedResults.length - completedTasks,
    needsReconciliation: result.needsReconciliation ?? reconciliationIssues.length > 0,
    reconciliationIssues,
    reconciliationSummary,
    reconciliationPlan,
    budget: result.budget ?? { tasks: {} },
    tasks: result.orderedResults.map((task) => ({
      taskId: task.taskId,
      status: task.status,
      summary: task.summary,
      attempts: task.attempts,
      dependencies: [...task.dependencies],
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      result: task.result,
      metadata: task.metadata,
      budget: task.budget,
      reconciliationIssueIds: issueIdsByTask[task.taskId],
      skippedReason: task.skippedReason,
      timedOut: task.timedOut,
      error: task.error,
    })),
  };
}

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

export function formatWorkflowNotification(result: WorkflowRunResult | WorkflowNotification): string {
  const notification = isWorkflowRunResult(result) ? createWorkflowNotification(result) : result;
  return [
    "<workflow-notification>",
    `<payload>${escapeXml(JSON.stringify(notification))}</payload>`,
    "</workflow-notification>",
  ].join("\n");
}

export function parseWorkflowNotification(text: string): WorkflowNotification | undefined {
  const match = text.match(/<workflow-notification>\s*<payload>([\s\S]*?)<\/payload>\s*<\/workflow-notification>/);
  if (!match) return undefined;
  try {
    const payload = JSON.parse(unescapeXml(match[1]!));
    return isWorkflowNotification(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

export async function runWorkflow(
  spec: WorkflowSpec,
  runner: WorkflowRunner,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult> {
  const plan = createWorkflowPlan(spec);
  const failurePolicy = spec.failurePolicy ?? "skip-dependents";
  const results = createInitialResults(plan, options.initialResults);
  const running = new Set<string>();
  const runningTasks = new Map<string, WorkflowRunningTask>();
  const blockedTasks = new Map<string, WorkflowBlockedTask>();
  const resumableRunningTasks = createInitialRunningTasks(plan, options.initialRunningTasks);
  const ready = createInitialReadyQueue(plan, results, failurePolicy);
  const runId = options.runId ?? createWorkflowRunId();
  const createdAt = options.createdAt ?? Date.now();
  let failFastTriggered = failurePolicy === "fail-fast" && hasFailedInitialResult(results);
  let lastSoftBudgetSignal: string | undefined;

  const emitSnapshot = (status: WorkflowRunSnapshotStatus, summary = `${results.size}/${plan.tasks.length} tasks finished`) => {
    try {
      options.onSnapshot?.(createWorkflowRunSnapshot({
        runId,
        status,
        summary,
        spec,
        plan,
        results,
        running,
        runningTasks,
        blockedTasks,
        createdAt,
      }));
    } catch {
      // Snapshot persistence is best-effort and must not strand the scheduler.
    }
  };

  const emitEvent = (event: Omit<WorkflowRunEvent, "version" | "runId" | "timestamp">) => {
    try {
      options.onEvent?.({
        version: 1,
        runId,
        timestamp: Date.now(),
        ...event,
      });
    } catch {
      // Observability callbacks are best-effort and must not strand the scheduler.
    }
  };

  await new Promise<void>((resolve) => {
    const maybeResolve = () => {
      if (results.size === plan.tasks.length) resolve();
    };

    const skipTask = (taskId: string, reason: string) => {
      if (results.has(taskId) || running.has(taskId)) return;
      removeReady(ready, taskId);
      blockedTasks.delete(taskId);
      const now = Date.now();
      const task = requireWorkflowTask(plan.tasks, taskId);
      const skippedResult: WorkflowTaskRunResult = {
        taskId,
        status: "skipped",
        summary: reason,
        attempts: 0,
        dependencies: [...(task.dependsOn ?? [])],
        startedAt: now,
        finishedAt: now,
        skippedReason: reason,
      };
      results.set(taskId, skippedResult);
      emitEvent({
        type: "task_finished",
        taskId,
        status: "skipped",
        summary: reason,
        result: skippedResult,
      });
      emitSnapshot("running");
      for (const dependent of plan.dependentsMap[taskId] ?? []) {
        skipTask(dependent, `Skipped because dependency '${taskId}' did not complete`);
      }
    };

    const skipUnstarted = (reason: string) => {
      for (const task of plan.tasks) {
        if (!results.has(task.id) && !running.has(task.id)) {
          skipTask(task.id, reason);
        }
      }
    };

    const propagateInitialFailures = () => {
      for (const result of [...results.values()]) {
        if (result.status === "completed") continue;
        if (failurePolicy === "fail-fast") {
          failFastTriggered = true;
          skipUnstarted(`Skipped after '${result.taskId}' failed`);
        } else if (failurePolicy === "skip-dependents") {
          for (const dependent of plan.dependentsMap[result.taskId] ?? []) {
            skipTask(dependent, `Skipped because dependency '${result.taskId}' did not complete`);
          }
        }
      }
    };

    const onFinished = (result: WorkflowTaskRunResult) => {
      running.delete(result.taskId);
      runningTasks.delete(result.taskId);
      results.set(result.taskId, result);
      refreshBlockedTasks();
      emitEvent({
        type: "task_finished",
        taskId: result.taskId,
        status: result.status,
        summary: result.summary,
        result,
      });
      emitSnapshot("running");

      if (result.status !== "completed") {
        if (failurePolicy === "fail-fast") {
          failFastTriggered = true;
          skipUnstarted(`Skipped after '${result.taskId}' failed`);
        } else if (failurePolicy === "skip-dependents") {
          for (const dependent of plan.dependentsMap[result.taskId] ?? []) {
            skipTask(dependent, `Skipped because dependency '${result.taskId}' did not complete`);
          }
        }
      }

      if (!failFastTriggered) {
        for (const dependent of plan.dependentsMap[result.taskId] ?? []) {
          if (results.has(dependent) || running.has(dependent) || ready.includes(dependent)) {
            continue;
          }
          const dependencies = plan.dependencyMap[dependent] ?? [];
          const canRun =
            failurePolicy === "continue"
              ? dependencies.every((id) => results.has(id))
              : dependencies.every((id) => results.get(id)?.status === "completed");
          if (canRun) {
            ready.push(dependent);
            sortReady(ready, plan.executionOrder);
          }
        }
      }

      scheduleMore();
      maybeResolve();
    };

    const scheduleMore = () => {
      if (failFastTriggered) return;
      while (running.size < plan.maxConcurrency && ready.length > 0) {
        const budget = collectWorkflowBudgetUsage([...results.values()], [...runningTasks.values()]);
        const exceededBudget = workflowBudgetPolicyExceeded(plan.budgetPolicy, budget);
        if (exceededBudget) {
          emitEvent({
            type: "workflow_budget_exceeded",
            status: "running",
            summary: exceededBudget,
          });
          skipUnstarted(exceededBudget);
          break;
        }
        const softBudget = workflowBudgetSoftLimit(plan.budgetPolicy, budget);
        if (softBudget && lastSoftBudgetSignal !== softBudget.summary) {
          lastSoftBudgetSignal = softBudget.summary;
          emitEvent({
            type: "workflow_budget_conserving",
            status: "running",
            summary: softBudget.summary,
          });
        }
        if (softBudget?.serialize === true && running.size > 0) {
          break;
        }
        const readyIndex = findNextRunnableReadyIndex(ready, running, plan.tasks);
        if (readyIndex < 0) {
          refreshBlockedTasks();
          emitSnapshot("running", `${results.size}/${plan.tasks.length} tasks finished; ${blockedTasks.size} task(s) blocked`);
          for (const blockedTask of blockedTasks.values()) {
            emitEvent({
              type: "task_blocked",
              taskId: blockedTask.taskId,
              status: "pending",
              summary: blockedTask.reason,
              blockedTask,
            });
          }
          break;
        }
        const [taskId] = ready.splice(readyIndex, 1);
        if (!taskId || results.has(taskId) || running.has(taskId)) continue;
        blockedTasks.delete(taskId);
        const task = requireWorkflowTask(plan.tasks, taskId);
        running.add(taskId);
        const resumeFrom = resumableRunningTasks.get(taskId);
        const runningTask = resumeFrom ?? {
          taskId,
          attempt: 1,
          dependencies: [...(task.dependsOn ?? [])],
          startedAt: Date.now(),
          summary: "Task running",
        };
        runningTasks.set(taskId, runningTask);
        emitEvent({
          type: "task_started",
          taskId,
          attempt: runningTask.attempt,
          status: "running",
          summary: runningTask.summary,
          runningTask,
        });
        emitSnapshot("running");
        runWorkflowTask(
          task,
          runner,
          collectDependencyResults(task, results),
          pipelineInputFor(plan, task, results),
          resumeFrom,
          resolveTaskTimeoutMs(plan, task),
          softBudget?.conserve === true ? "conserve" : "normal",
          softBudget?.conserve === true ? plan.budgetPolicy?.conserve : undefined,
          (progress) => {
            const current = runningTasks.get(taskId);
            if (!current) return;
            runningTasks.set(taskId, {
              ...current,
              summary: progress.summary ?? current.summary,
              metadata: progress.metadata ?? current.metadata,
              budget: progress.budget ?? workflowBudgetFromMetadata(progress.metadata) ?? current.budget,
            });
            emitEvent({
              type: "task_progress",
              taskId,
              attempt: current.attempt,
              status: "running",
              summary: progress.summary ?? current.summary,
              runningTask: runningTasks.get(taskId),
            });
            emitSnapshot("running");
          },
        )
          .then(onFinished);
      }
    };

    const refreshBlockedTasks = () => {
      blockedTasks.clear();
      for (const taskId of ready) {
        const blocked = createBlockedTask(taskId, running, plan.tasks);
        if (blocked) blockedTasks.set(taskId, blocked);
      }
    };

    emitEvent({ type: "workflow_started", status: "running", summary: "Workflow started" });
    emitSnapshot("running", "Workflow started");
    propagateInitialFailures();
    scheduleMore();
    maybeResolve();
  });

  const finalResult = aggregateWorkflowResult(runId, plan, results);
  emitEvent({
    type: "workflow_finished",
    status: finalResult.status,
    summary: finalResult.summary,
  });
  emitSnapshot(finalResult.status, finalResult.summary);
  return finalResult;
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

async function runWorkflowTask(
  task: WorkflowTask,
  runner: WorkflowRunner,
  dependencyResults: Record<string, WorkflowTaskRunResult>,
  pipelineInput: WorkflowTaskRunResult | undefined,
  resumeFrom: WorkflowRunningTask | undefined,
  timeoutMs: number | undefined,
  budgetMode: "normal" | "conserve",
  budgetConserve: WorkflowConservePolicy | undefined,
  reportProgress: (progress: WorkflowTaskProgress) => void,
): Promise<WorkflowTaskRunResult> {
  const retry = normalizeRetry(task.retry);
  const startedAt = Date.now();
  let lastResult: WorkflowWorkerResult | undefined;
  let lastError: string | undefined;
  let lastProgressBudget: WorkflowTaskBudgetUsage | undefined;
  const recordProgress = (progress: WorkflowTaskProgress) => {
    lastProgressBudget = progress.budget ?? workflowBudgetFromMetadata(progress.metadata) ?? lastProgressBudget;
    reportProgress({
      ...progress,
      budget: progress.budget ?? workflowBudgetFromMetadata(progress.metadata),
    });
  };

  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    try {
      recordProgress({
        summary: attempt === 1 ? "Task running" : `Retry attempt ${attempt} running`,
      });
      lastResult = await runRunnerAttempt(
        runner({
          task,
          attempt,
          dependencyResults,
          pipelineInput,
          resumeFrom: attempt === 1 ? resumeFrom : undefined,
          budgetMode,
          budgetConserve,
          reportProgress: recordProgress,
        }),
        timeoutMs,
      );
      const status = lastResult.status ?? "completed";
      if (status === "completed" || !retry.retryOn.includes(status) || attempt === retry.maxAttempts) {
        return {
          ...lastResult,
          taskId: task.id,
          status,
          budget: workflowBudgetFromMetadata(lastResult.metadata) ?? lastProgressBudget,
          attempts: attempt,
          dependencies: [...(task.dependsOn ?? [])],
          startedAt,
          finishedAt: Date.now(),
        };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      const timedOut = error instanceof WorkflowTaskTimeoutError;
      if (!retry.retryOn.includes("failed") || attempt === retry.maxAttempts) {
        return {
          taskId: task.id,
          status: "failed",
          summary: lastError,
          budget: lastProgressBudget,
          attempts: attempt,
          dependencies: [...(task.dependsOn ?? [])],
          startedAt,
          finishedAt: Date.now(),
          timedOut,
          error: lastError,
        };
      }
    }
  }

  return {
    taskId: task.id,
    status: "failed",
    summary: lastResult?.summary ?? lastError ?? "Task failed",
    result: lastResult?.result,
    metadata: lastResult?.metadata,
    budget: workflowBudgetFromMetadata(lastResult?.metadata) ?? lastProgressBudget,
    attempts: retry.maxAttempts,
    dependencies: [...(task.dependsOn ?? [])],
    startedAt,
    finishedAt: Date.now(),
    error: lastError,
  };
}

async function runRunnerAttempt(
  result: Promise<WorkflowWorkerResult> | WorkflowWorkerResult,
  timeoutMs: number | undefined,
): Promise<WorkflowWorkerResult> {
  const resultPromise = Promise.resolve(result);
  if (timeoutMs === undefined) return resultPromise;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new WorkflowTaskTimeoutError(timeoutMs)), timeoutMs);
  });

  try {
    return await Promise.race([resultPromise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

class WorkflowTaskTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Task timed out after ${timeoutMs}ms`);
    this.name = "WorkflowTaskTimeoutError";
  }
}

function resolveTaskTimeoutMs(plan: WorkflowPlan, task: WorkflowTask): number | undefined {
  const timeoutMs = task.timeoutMs ?? plan.defaultTaskTimeoutMs;
  return timeoutMs === undefined ? undefined : Math.floor(timeoutMs);
}

function normalizeRetry(policy: WorkflowRetryPolicy | undefined): Required<WorkflowRetryPolicy> {
  return {
    maxAttempts: Math.max(1, Math.floor(policy?.maxAttempts ?? 1)),
    retryOn: policy?.retryOn ?? ["failed"],
  };
}

function collectDependencyResults(
  task: WorkflowTask,
  results: Map<string, WorkflowTaskRunResult>,
): Record<string, WorkflowTaskRunResult> {
  return Object.fromEntries(
    (task.dependsOn ?? [])
      .map((taskId) => [taskId, results.get(taskId)] as const)
      .filter((entry): entry is readonly [string, WorkflowTaskRunResult] => entry[1] !== undefined),
  );
}

function pipelineInputFor(
  plan: WorkflowPlan,
  task: WorkflowTask,
  results: Map<string, WorkflowTaskRunResult>,
): WorkflowTaskRunResult | undefined {
  if (plan.mode !== "pipeline") return undefined;
  const previous = plan.tasks[plan.tasks.findIndex((candidate) => candidate.id === task.id) - 1];
  return previous ? results.get(previous.id) : undefined;
}

function requireWorkflowTask(tasks: WorkflowTask[], taskId: string): WorkflowTask {
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Unknown workflow task '${taskId}'`);
  return task;
}

function removeReady(ready: string[], taskId: string): void {
  const index = ready.indexOf(taskId);
  if (index >= 0) ready.splice(index, 1);
}

function sortReady(ready: string[], executionOrder: string[]): void {
  ready.sort((a, b) => executionOrder.indexOf(a) - executionOrder.indexOf(b));
}

function findNextRunnableReadyIndex(
  ready: string[],
  running: Set<string>,
  tasks: WorkflowTask[],
): number {
  return ready.findIndex((taskId) => {
    const candidate = requireWorkflowTask(tasks, taskId);
    return [...running].every((runningTaskId) => {
      const runningTask = requireWorkflowTask(tasks, runningTaskId);
      return !workflowTasksConflict(candidate, runningTask);
    });
  });
}

function createBlockedTask(
  taskId: string,
  running: Set<string>,
  tasks: WorkflowTask[],
): WorkflowBlockedTask | undefined {
  const candidate = requireWorkflowTask(tasks, taskId);
  const writeScope = runnableWriteScopes(candidate);
  const waitingForTaskIds: string[] = [];
  const conflictingWriteScope = new Set<string>();

  for (const runningTaskId of running) {
    const runningTask = requireWorkflowTask(tasks, runningTaskId);
    const runningScopes = runnableWriteScopes(runningTask);
    const overlaps = writeScope.filter((scope) =>
      runningScopes.some((runningScope) => writeScopesOverlap(scope, runningScope)),
    );
    if (overlaps.length === 0) continue;
    waitingForTaskIds.push(runningTaskId);
    for (const scope of overlaps) conflictingWriteScope.add(scope);
    for (const scope of runningScopes) {
      if (writeScope.some((candidateScope) => writeScopesOverlap(candidateScope, scope))) {
        conflictingWriteScope.add(scope);
      }
    }
  }

  if (waitingForTaskIds.length === 0) return undefined;
  return {
    taskId,
    reason: `Waiting for non-isolated writeScope conflict with ${waitingForTaskIds.join(", ")}`,
    waitingForTaskIds,
    writeScope,
    conflictingWriteScope: [...conflictingWriteScope],
  };
}

function createInitialResults(
  plan: WorkflowPlan,
  initialResults: Record<string, WorkflowTaskRunResult> | undefined,
): Map<string, WorkflowTaskRunResult> {
  const taskIds = new Set(plan.tasks.map((task) => task.id));
  const results = new Map<string, WorkflowTaskRunResult>();
  for (const [taskId, result] of Object.entries(initialResults ?? {})) {
    if (!taskIds.has(taskId)) {
      throw new Error(`Initial workflow result references unknown task '${taskId}'`);
    }
    results.set(taskId, result);
  }
  return results;
}

function createInitialRunningTasks(
  plan: WorkflowPlan,
  initialRunningTasks: Record<string, WorkflowRunningTask> | undefined,
): Map<string, WorkflowRunningTask> {
  const taskIds = new Set(plan.tasks.map((task) => task.id));
  const runningTasks = new Map<string, WorkflowRunningTask>();
  for (const [taskId, task] of Object.entries(initialRunningTasks ?? {})) {
    if (!taskIds.has(taskId)) {
      throw new Error(`Initial running workflow task references unknown task '${taskId}'`);
    }
    runningTasks.set(taskId, task);
  }
  return runningTasks;
}

function createInitialReadyQueue(
  plan: WorkflowPlan,
  results: Map<string, WorkflowTaskRunResult>,
  failurePolicy: WorkflowFailurePolicy,
): string[] {
  const ready = plan.executionOrder.filter((taskId) => {
    if (results.has(taskId)) return false;
    const dependencies = plan.dependencyMap[taskId] ?? [];
    if (dependencies.length === 0) return true;
    return failurePolicy === "continue"
      ? dependencies.every((id) => results.has(id))
      : dependencies.every((id) => results.get(id)?.status === "completed");
  });
  sortReady(ready, plan.executionOrder);
  return ready;
}

function hasFailedInitialResult(results: Map<string, WorkflowTaskRunResult>): boolean {
  return [...results.values()].some((result) => result.status !== "completed" && result.status !== "skipped");
}

function collectWorkflowReconciliationIssues(
  plan: WorkflowPlan,
  orderedResults: WorkflowTaskRunResult[],
): WorkflowReconciliationIssue[] {
  const resultByTaskId = new Map(orderedResults.map((result) => [result.taskId, result]));
  const completedTaskIds = new Set(
    orderedResults
      .filter((result) => result.status === "completed")
      .map((result) => result.taskId),
  );
  const issues: WorkflowReconciliationIssue[] = [];
  const actualConflictPairs = new Set<string>();
  const tasks = plan.executionOrder
    .map((taskId) => requireWorkflowTask(plan.tasks, taskId))
    .filter((task) => completedTaskIds.has(task.id));

  for (let i = 0; i < tasks.length; i += 1) {
    const left = tasks[i]!;
    const leftChangedFiles = changedFilesFromResult(resultByTaskId.get(left.id));
    const leftScopes = runnableWriteScopes(left);
    for (const right of tasks.slice(i + 1)) {
      const pairId = `${left.id}-${right.id}`;
      const rightChangedFiles = changedFilesFromResult(resultByTaskId.get(right.id));
      const changedFiles = leftChangedFiles.filter((leftFile) => rightChangedFiles.includes(leftFile));
      if (changedFiles.length > 0) {
        actualConflictPairs.add(pairId);
        issues.push({
          issueId: `reconcile-actual-${pairId}`,
          type: "changed-file-overlap",
          severity: "actual-conflict",
          taskIds: [left.id, right.id],
          writeScope: [...new Set([...runnableWriteScopes(left), ...runnableWriteScopes(right)])].sort(),
          changedFiles: [...new Set(changedFiles)].sort(),
          summary: `Tasks '${left.id}' and '${right.id}' both changed: ${[...new Set(changedFiles)].sort().join(", ")}`,
        });
        continue;
      }

      if (actualConflictPairs.has(pairId) || leftScopes.length === 0) continue;
      const rightScopes = runnableWriteScopes(right);
      const overlap = leftScopes.filter((leftScope) =>
        rightScopes.some((rightScope) => writeScopesOverlap(leftScope, rightScope)),
      );
      if (overlap.length === 0) continue;
      const rightOverlap = rightScopes.filter((rightScope) =>
        leftScopes.some((leftScope) => writeScopesOverlap(leftScope, rightScope)),
      );
      const writeScope = [...new Set([...overlap, ...rightOverlap])].sort();
      issues.push({
        issueId: `reconcile-${left.id}-${right.id}`,
        type: "write-scope-overlap",
        severity: "needs-reconciliation",
        taskIds: [left.id, right.id],
        writeScope,
        summary: `Tasks '${left.id}' and '${right.id}' wrote overlapping scopes: ${writeScope.join(", ")}`,
      });
    }
  }

  return issues;
}

function createReconciliationIssueIdsByTask(
  issues: WorkflowReconciliationIssue[],
): Record<string, string[]> {
  const byTask: Record<string, string[]> = {};
  for (const issue of issues) {
    for (const taskId of issue.taskIds) {
      byTask[taskId] = [...(byTask[taskId] ?? []), issue.issueId];
    }
  }
  return byTask;
}

export function createWorkflowReconciliationSummary(
  issues: WorkflowReconciliationIssue[],
  orderedResults: WorkflowTaskRunResult[],
): WorkflowReconciliationSummary {
  const resultByTaskId = new Map(orderedResults.map((result) => [result.taskId, result]));
  const fileSummaries = new Map<string, {
    issueIds: Set<string>;
    taskIds: Set<string>;
    statuses: Record<string, WorkflowDiffFileSummary["status"]>;
    insertionsByTask: Map<string, number>;
    deletionsByTask: Map<string, number>;
  }>();
  const taskSummaries = new Map<string, {
    issueIds: Set<string>;
    changedFiles: Set<string>;
    insertionsByFile: Map<string, number>;
    deletionsByFile: Map<string, number>;
  }>();

  for (const issue of issues) {
    const issueFiles = issue.changedFiles?.map(normalizeWriteScope).filter((file) => file.length > 0);
    for (const taskId of issue.taskIds) {
      const taskSummary = taskSummaries.get(taskId) ?? {
        issueIds: new Set<string>(),
        changedFiles: new Set<string>(),
        insertionsByFile: new Map<string, number>(),
        deletionsByFile: new Map<string, number>(),
      };
      taskSummary.issueIds.add(issue.issueId);
      taskSummaries.set(taskId, taskSummary);

      const diffFiles = diffFilesFromResult(resultByTaskId.get(taskId));
      const filesForTask = issueFiles?.length
        ? diffFiles.filter((file) => issueFiles.includes(file.path))
        : diffFiles.filter((file) => issue.writeScope.some((scope) => writeScopesOverlap(file.path, normalizeWriteScope(scope))));
      for (const file of filesForTask) {
        taskSummary.changedFiles.add(file.path);
        taskSummary.insertionsByFile.set(file.path, file.insertions ?? 0);
        taskSummary.deletionsByFile.set(file.path, file.deletions ?? 0);

        const fileSummary = fileSummaries.get(file.path) ?? {
          issueIds: new Set<string>(),
          taskIds: new Set<string>(),
          statuses: {},
          insertionsByTask: new Map<string, number>(),
          deletionsByTask: new Map<string, number>(),
        };
        fileSummary.issueIds.add(issue.issueId);
        fileSummary.taskIds.add(taskId);
        fileSummary.statuses[taskId] = file.status;
        fileSummary.insertionsByTask.set(taskId, file.insertions ?? 0);
        fileSummary.deletionsByTask.set(taskId, file.deletions ?? 0);
        fileSummaries.set(file.path, fileSummary);
      }
    }
  }

  return {
    totalIssues: issues.length,
    actualConflicts: issues.filter((issue) => issue.severity === "actual-conflict").length,
    declaredScopeOverlaps: issues.filter((issue) => issue.type === "write-scope-overlap").length,
    files: [...fileSummaries.entries()]
      .map(([path, summary]) => ({
        path,
        issueIds: [...summary.issueIds].sort(),
        taskIds: [...summary.taskIds].sort(),
        statuses: Object.fromEntries(Object.entries(summary.statuses).sort(([left], [right]) => left.localeCompare(right))),
        insertions: sumMapValues(summary.insertionsByTask),
        deletions: sumMapValues(summary.deletionsByTask),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    tasks: [...taskSummaries.entries()]
      .map(([taskId, summary]) => ({
        taskId,
        issueIds: [...summary.issueIds].sort(),
        changedFiles: [...summary.changedFiles].sort(),
        insertions: sumMapValues(summary.insertionsByFile),
        deletions: sumMapValues(summary.deletionsByFile),
      }))
      .sort((left, right) => left.taskId.localeCompare(right.taskId)),
  };
}

export function createWorkflowReconciliationPlan(
  issues: WorkflowReconciliationIssue[],
): WorkflowReconciliationPlan {
  if (issues.length === 0) {
    return {
      needed: false,
      summary: "No reconciliation follow-up needed",
      actions: [],
    };
  }

  const actions = issues.map((issue) => {
    const taskId = `reconcile-${issue.issueId}`.replace(/[^A-Za-z0-9._-]/g, "-");
    const changedFiles = issue.changedFiles?.length ? `Changed files: ${issue.changedFiles.join(", ")}.` : "";
    const writeScope = issue.changedFiles?.length ? issue.changedFiles : issue.writeScope;
    return {
      actionId: `followup-${issue.issueId}`,
      issueIds: [issue.issueId],
      taskId,
      description: `Reconcile ${issue.type} for ${issue.taskIds.join(" and ")}`,
      prompt: [
        `Reconcile workflow issue ${issue.issueId}.`,
        issue.summary,
        `Affected tasks: ${issue.taskIds.join(", ")}.`,
        writeScope.length > 0 ? `Write scope: ${writeScope.join(", ")}.` : undefined,
        changedFiles || undefined,
        "Inspect the task outputs and current files, apply the smallest safe fix, and report any remaining conflict.",
      ].filter((line): line is string => line !== undefined && line.length > 0).join("\n"),
      writeScope: [...new Set(writeScope)].sort(),
      dependsOn: [...issue.taskIds],
    };
  });

  return {
    needed: true,
    summary: `${issues.length} reconciliation follow-up action(s) available`,
    actions,
  };
}

export function createWorkflowSpecFromReconciliationPlan(
  plan: WorkflowReconciliationPlan,
  options: WorkflowReconciliationSpecOptions = {},
): WorkflowSpec | undefined {
  const actions = plan.actions.filter((action) => {
    const matchesAction = !options.actionIds || options.actionIds.includes(action.actionId);
    const matchesIssue = !options.issueIds || action.issueIds.some((issueId) => options.issueIds?.includes(issueId));
    return matchesAction && matchesIssue;
  });
  if (actions.length === 0) return undefined;

  const reconcileTasks: WorkflowTask[] = actions.map((action) => ({
    id: action.taskId,
    description: action.description,
    prompt: action.prompt,
    writeScope: [...action.writeScope],
    isolate: true,
    metadata: {
      reconciliationActionId: action.actionId,
      reconciliationIssueIds: [...action.issueIds],
    },
  }));
  const verifyTaskId = options.verifyTaskId ?? "verify-reconciliation";
  return {
    mode: "parallel",
    maxConcurrency: 1,
    failurePolicy: "fail-fast",
    budgetPolicyPreset: options.budgetPolicyPreset ?? "safe-write",
    tasks: [
      ...reconcileTasks,
      {
        id: verifyTaskId,
        description: "Verify reconciliation changes and summarize any remaining conflicts.",
        prompt: [
          "Verify the reconciliation work from the preceding tasks.",
          `Reconciled tasks: ${reconcileTasks.map((task) => task.id).join(", ")}.`,
          "Run targeted checks where practical, inspect the touched files, and report any remaining conflict.",
        ].join("\n"),
        readOnly: true,
        dependsOn: reconcileTasks.map((task) => task.id),
      },
    ],
  };
}

function summaryWithReconciliation(summary: string, issues: WorkflowReconciliationIssue[]): string {
  return issues.length === 0 || summary.includes("reconciliation issue")
    ? summary
    : `${summary}; ${issues.length} reconciliation issue(s)`;
}

function changedFilesFromResult(result: WorkflowTaskRunResult | undefined): string[] {
  const metadata = result?.metadata;
  if (!metadata) return [];
  const value = Array.isArray(metadata.changedFiles)
    ? metadata.changedFiles
    : isRecord(metadata.diff) && Array.isArray(metadata.diff.changedFiles)
      ? metadata.diff.changedFiles
      : isRecord(metadata.diff) && Array.isArray(metadata.diff.files)
        ? metadata.diff.files.map((file) => isRecord(file) ? file.path : undefined)
      : undefined;
  if (!value) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map(normalizeWriteScope)
    .filter((file) => file.length > 0);
}

function diffFilesFromResult(result: WorkflowTaskRunResult | undefined): WorkflowDiffFileSummary[] {
  const metadata = result?.metadata;
  if (!metadata) return [];
  if (isRecord(metadata.diff) && Array.isArray(metadata.diff.files)) {
    return metadata.diff.files
      .filter(isRecord)
      .map((file) => ({
        path: typeof file.path === "string" ? normalizeWriteScope(file.path) : "",
        status: normalizeDiffFileStatus(file.status),
        insertions: typeof file.insertions === "number" && Number.isFinite(file.insertions) ? file.insertions : undefined,
        deletions: typeof file.deletions === "number" && Number.isFinite(file.deletions) ? file.deletions : undefined,
      }))
      .filter((file) => file.path.length > 0);
  }
  return changedFilesFromResult(result).map((path) => ({
    path,
    status: "other",
  }));
}

function normalizeDiffFileStatus(status: unknown): WorkflowDiffFileSummary["status"] {
  return status === "added" ||
    status === "modified" ||
    status === "deleted" ||
    status === "renamed" ||
    status === "untracked" ||
    status === "other"
    ? status
    : "other";
}

function sumMapValues(values: Map<string, number>): number {
  return [...values.values()].reduce((total, value) => total + value, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function aggregateWorkflowResult(
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

function isWorkflowRunResult(value: WorkflowRunResult | WorkflowNotification): value is WorkflowRunResult {
  return "plan" in value && "orderedResults" in value;
}

function isWorkflowNotification(value: unknown): value is WorkflowNotification {
  if (!value || typeof value !== "object") return false;
  const candidate = value as WorkflowNotification;
  return (
    (candidate.status === "completed" || candidate.status === "failed") &&
    typeof candidate.summary === "string" &&
    (candidate.mode === "parallel" || candidate.mode === "sequential" || candidate.mode === "pipeline") &&
    typeof candidate.totalTasks === "number" &&
    typeof candidate.completedTasks === "number" &&
    typeof candidate.failedTasks === "number" &&
    Array.isArray(candidate.tasks) &&
    candidate.tasks.every(isWorkflowNotificationTask)
  );
}

function isWorkflowNotificationTask(value: unknown): value is WorkflowNotificationTask {
  if (!value || typeof value !== "object") return false;
  const candidate = value as WorkflowNotificationTask;
  return (
    typeof candidate.taskId === "string" &&
    (candidate.status === "completed" ||
      candidate.status === "failed" ||
      candidate.status === "killed" ||
      candidate.status === "skipped") &&
    typeof candidate.summary === "string" &&
    typeof candidate.attempts === "number" &&
    Array.isArray(candidate.dependencies) &&
    typeof candidate.startedAt === "number" &&
    typeof candidate.finishedAt === "number"
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function unescapeXml(value: string): string {
  return value
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}
