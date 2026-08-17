import {
  collectWorkflowBudgetUsage,
  workflowBudgetFromMetadata,
  workflowBudgetPolicyExceeded,
  workflowBudgetSoftLimit,
} from "./budget.js";
import {
  createWorkflowPlan,
  runnableWriteScopes,
  workflowTasksConflict,
  writeScopesOverlap,
} from "./validation.js";
import { aggregateWorkflowResult, createWorkflowRunId, createWorkflowRunSnapshot } from "./snapshot.js";
import { resolveTaskTimeoutMs, runWorkflowTask } from "./task-runner.js";
import type {
  WorkflowBlockedTask,
  WorkflowFailurePolicy,
  WorkflowPlan,
  WorkflowRunEvent,
  WorkflowRunOptions,
  WorkflowRunResult,
  WorkflowRunSnapshotStatus,
  WorkflowRunner,
  WorkflowRunningTask,
  WorkflowSpec,
  WorkflowTask,
  WorkflowTaskProgress,
  WorkflowTaskRunResult,
} from "./model.js";

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
        ownerSession: options.ownerSession,
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
