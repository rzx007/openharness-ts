export type WorkflowMode = "parallel" | "sequential" | "pipeline";

export type WorkflowFailurePolicy = "skip-dependents" | "fail-fast" | "continue";

export type WorkflowTaskTerminalStatus = "completed" | "failed" | "killed" | "skipped";

export type WorkflowTaskStatus = "pending" | "running" | WorkflowTaskTerminalStatus;

export interface WorkflowRetryPolicy {
  /** Total attempts, including the first attempt. Defaults to 1. */
  maxAttempts?: number;
  /** Statuses that should be retried. Defaults to ["failed"]. */
  retryOn?: Array<"failed" | "killed">;
}

export interface WorkflowTask {
  id: string;
  description?: string;
  prompt?: string;
  subagentType?: string;
  model?: string;
  team?: string;
  permissionMode?: "default" | "plan" | "full_auto";
  dependsOn?: string[];
  retry?: WorkflowRetryPolicy;
  timeoutMs?: number;
  readOnly?: boolean;
  writeScope?: string[];
  isolate?: boolean;
  metadata?: Record<string, unknown>;
}

export interface WorkflowSpec {
  mode: WorkflowMode;
  tasks: WorkflowTask[];
  maxConcurrency?: number;
  defaultTaskTimeoutMs?: number;
  failurePolicy?: WorkflowFailurePolicy;
}

export interface WorkflowPlan {
  mode: WorkflowMode;
  tasks: WorkflowTask[];
  maxConcurrency: number;
  defaultTaskTimeoutMs?: number;
  executionOrder: string[];
  dependencyMap: Record<string, string[]>;
  dependentsMap: Record<string, string[]>;
}

export interface WorkflowWorkerResult {
  status?: Exclude<WorkflowTaskTerminalStatus, "skipped">;
  summary: string;
  result?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowTaskRunResult {
  taskId: string;
  status: WorkflowTaskTerminalStatus;
  summary: string;
  result?: string;
  metadata?: Record<string, unknown>;
  attempts: number;
  dependencies: string[];
  startedAt: number;
  finishedAt: number;
  skippedReason?: string;
  timedOut?: boolean;
  error?: string;
}

export interface WorkflowRunnerContext {
  task: WorkflowTask;
  attempt: number;
  dependencyResults: Record<string, WorkflowTaskRunResult>;
  pipelineInput?: WorkflowTaskRunResult;
  resumeFrom?: WorkflowRunningTask;
  reportProgress?: (progress: WorkflowTaskProgress) => void;
}

export type WorkflowRunner = (
  context: WorkflowRunnerContext,
) => Promise<WorkflowWorkerResult> | WorkflowWorkerResult;

export interface WorkflowRunResult {
  runId?: string;
  status: "completed" | "failed";
  summary: string;
  plan: WorkflowPlan;
  results: Record<string, WorkflowTaskRunResult>;
  orderedResults: WorkflowTaskRunResult[];
}

export interface WorkflowRunSnapshotPlan {
  mode: WorkflowMode;
  tasks: WorkflowTask[];
  maxConcurrency: number | "unbounded";
  defaultTaskTimeoutMs?: number;
  executionOrder: string[];
  dependencyMap: Record<string, string[]>;
  dependentsMap: Record<string, string[]>;
}

export interface WorkflowRunningTask {
  taskId: string;
  attempt: number;
  dependencies: string[];
  startedAt: number;
  summary: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowTaskProgress {
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowBlockedTask {
  taskId: string;
  reason: string;
  waitingForTaskIds: string[];
  writeScope?: string[];
  conflictingWriteScope?: string[];
}

export type WorkflowRunSnapshotStatus = "running" | "completed" | "failed";

export interface WorkflowRunSnapshot {
  version: 1;
  runId: string;
  status: WorkflowRunSnapshotStatus;
  summary: string;
  spec: WorkflowSpec;
  plan: WorkflowRunSnapshotPlan;
  results: Record<string, WorkflowTaskRunResult>;
  orderedResults: WorkflowTaskRunResult[];
  pendingTaskIds: string[];
  blockedTaskIds: string[];
  blockedTasks: Record<string, WorkflowBlockedTask>;
  runningTaskIds: string[];
  runningTasks: Record<string, WorkflowRunningTask>;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowRunOptions {
  runId?: string;
  onSnapshot?: (snapshot: WorkflowRunSnapshot) => void;
  onEvent?: (event: WorkflowRunEvent) => void;
  initialResults?: Record<string, WorkflowTaskRunResult>;
  initialRunningTasks?: Record<string, WorkflowRunningTask>;
  createdAt?: number;
}

export type WorkflowRunEventType =
  | "workflow_started"
  | "task_started"
  | "task_progress"
  | "task_blocked"
  | "task_finished"
  | "workflow_finished";

export interface WorkflowRunEvent {
  version: 1;
  runId: string;
  type: WorkflowRunEventType;
  timestamp: number;
  summary?: string;
  taskId?: string;
  attempt?: number;
  status?: WorkflowTaskStatus | WorkflowRunResult["status"];
  runningTask?: WorkflowRunningTask;
  blockedTask?: WorkflowBlockedTask;
  result?: WorkflowTaskRunResult;
}

export interface WorkflowNotificationTask {
  taskId: string;
  status: WorkflowTaskTerminalStatus;
  summary: string;
  attempts: number;
  dependencies: string[];
  startedAt: number;
  finishedAt: number;
  result?: string;
  metadata?: Record<string, unknown>;
  skippedReason?: string;
  timedOut?: boolean;
  error?: string;
}

export interface WorkflowNotification {
  runId?: string;
  status: WorkflowRunResult["status"];
  summary: string;
  mode: WorkflowMode;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  tasks: WorkflowNotificationTask[];
}

export function createWorkflowPlan(spec: WorkflowSpec): WorkflowPlan {
  const tasks = normalizeTasksForMode(spec.mode, spec.tasks);
  validateWorkflowTimeouts(spec.defaultTaskTimeoutMs, tasks);
  validateWorkflowTasks(tasks);
  const dependencyMap = buildDependencyMap(tasks);
  const dependentsMap = buildDependentsMap(tasks);
  const executionOrder = topologicalOrder(tasks, dependencyMap);

  return {
    mode: spec.mode,
    tasks,
    maxConcurrency: resolveMaxConcurrency(spec.mode, spec.maxConcurrency),
    defaultTaskTimeoutMs: spec.defaultTaskTimeoutMs,
    executionOrder,
    dependencyMap,
    dependentsMap,
  };
}

export function createWorkflowNotification(result: WorkflowRunResult): WorkflowNotification {
  const completedTasks = result.orderedResults.filter((task) => task.status === "completed").length;
  return {
    runId: result.runId,
    status: result.status,
    summary: result.summary,
    mode: result.plan.mode,
    totalTasks: result.plan.tasks.length,
    completedTasks,
    failedTasks: result.orderedResults.length - completedTasks,
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
      skippedReason: task.skippedReason,
      timedOut: task.timedOut,
      error: task.error,
    })),
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

export function validateWorkflowTasks(tasks: WorkflowTask[]): void {
  const seen = new Set<string>();
  for (const task of tasks) {
    const id = task.id.trim();
    if (!id) {
      throw new Error("Workflow task id cannot be empty");
    }
    if (seen.has(id)) {
      throw new Error(`Duplicate workflow task id '${id}'`);
    }
    seen.add(id);
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (!seen.has(dependency)) {
        throw new Error(`Task '${task.id}' depends on missing task '${dependency}'`);
      }
    }
  }

  topologicalOrder(tasks, buildDependencyMap(tasks));
}

export function workflowTasksConflict(a: WorkflowTask, b: WorkflowTask): boolean {
  const aScopes = runnableWriteScopes(a);
  const bScopes = runnableWriteScopes(b);
  if (aScopes.length === 0 || bScopes.length === 0) return false;
  return aScopes.some((aScope) => bScopes.some((bScope) => writeScopesOverlap(aScope, bScope)));
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
          (progress) => {
            const current = runningTasks.get(taskId);
            if (!current) return;
            runningTasks.set(taskId, {
              ...current,
              summary: progress.summary ?? current.summary,
              metadata: progress.metadata ?? current.metadata,
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
  return {
    runId: snapshot.runId,
    status: snapshot.status === "completed" ? "completed" : "failed",
    summary: snapshot.summary,
    plan: {
      ...snapshot.plan,
      maxConcurrency,
    },
    results: snapshot.results,
    orderedResults: snapshot.orderedResults,
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
        dependencies: [...task.dependencies],
      }]),
    ),
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
  reportProgress: (progress: WorkflowTaskProgress) => void,
): Promise<WorkflowTaskRunResult> {
  const retry = normalizeRetry(task.retry);
  const startedAt = Date.now();
  let lastResult: WorkflowWorkerResult | undefined;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    try {
      reportProgress({
        summary: attempt === 1 ? "Task running" : `Retry attempt ${attempt} running`,
      });
      lastResult = await runRunnerAttempt(
        runner({
          task,
          attempt,
          dependencyResults,
          pipelineInput,
          resumeFrom: attempt === 1 ? resumeFrom : undefined,
          reportProgress,
        }),
        timeoutMs,
      );
      const status = lastResult.status ?? "completed";
      if (status === "completed" || !retry.retryOn.includes(status) || attempt === retry.maxAttempts) {
        return {
          ...lastResult,
          taskId: task.id,
          status,
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

function normalizeTasksForMode(mode: WorkflowMode, tasks: WorkflowTask[]): WorkflowTask[] {
  return tasks.map((task, index) => {
    const dependsOn = [...(task.dependsOn ?? [])];
    if ((mode === "sequential" || mode === "pipeline") && index > 0) {
      const previous = tasks[index - 1]?.id;
      if (previous && !dependsOn.includes(previous)) {
        dependsOn.push(previous);
      }
    }
    return { ...task, id: task.id.trim(), dependsOn };
  });
}

function resolveMaxConcurrency(mode: WorkflowMode, value: number | undefined): number {
  if (mode === "sequential" || mode === "pipeline") return 1;
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(value) || value < 1) {
    throw new Error("maxConcurrency must be a positive number");
  }
  return Math.floor(value);
}

function validateWorkflowTimeouts(defaultTaskTimeoutMs: number | undefined, tasks: WorkflowTask[]): void {
  validateTimeoutMs(defaultTaskTimeoutMs, "defaultTaskTimeoutMs");
  for (const task of tasks) {
    validateTimeoutMs(task.timeoutMs, `tasks.${task.id}.timeoutMs`);
  }
}

function validateTimeoutMs(value: number | undefined, label: string): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
}

function resolveTaskTimeoutMs(plan: WorkflowPlan, task: WorkflowTask): number | undefined {
  const timeoutMs = task.timeoutMs ?? plan.defaultTaskTimeoutMs;
  return timeoutMs === undefined ? undefined : Math.floor(timeoutMs);
}

function buildDependencyMap(tasks: WorkflowTask[]): Record<string, string[]> {
  return Object.fromEntries(tasks.map((task) => [task.id, [...(task.dependsOn ?? [])]]));
}

function buildDependentsMap(tasks: WorkflowTask[]): Record<string, string[]> {
  const dependents = Object.fromEntries(tasks.map((task) => [task.id, [] as string[]]));
  for (const task of tasks) {
    for (const dependency of task.dependsOn ?? []) {
      dependents[dependency]?.push(task.id);
    }
  }
  return dependents;
}

function topologicalOrder(tasks: WorkflowTask[], dependencyMap: Record<string, string[]>): string[] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const result: string[] = [];

  const visit = (taskId: string, stack: string[]) => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) {
      throw new Error(`Workflow dependency cycle detected: ${[...stack, taskId].join(" -> ")}`);
    }
    visiting.add(taskId);
    for (const dependency of dependencyMap[taskId] ?? []) {
      visit(dependency, [...stack, taskId]);
    }
    visiting.delete(taskId);
    visited.add(taskId);
    result.push(taskId);
  };

  for (const task of tasks) {
    visit(task.id, []);
  }
  return result;
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

function runnableWriteScopes(task: WorkflowTask): string[] {
  if (task.readOnly === true || task.isolate === true) return [];
  return (task.writeScope ?? []).map(normalizeWriteScope).filter((scope) => scope.length > 0);
}

function normalizeWriteScope(scope: string): string {
  const normalized = scope.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
  return normalized === "." ? "" : normalized.toLowerCase();
}

function writeScopesOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
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
  return {
    runId,
    status: failed === 0 ? "completed" : "failed",
    summary: `${completed}/${plan.tasks.length} tasks completed`,
    plan,
    results: Object.fromEntries(orderedResults.map((result) => [result.taskId, result])),
    orderedResults,
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
