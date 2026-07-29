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
  readOnly?: boolean;
  writeScope?: string[];
  isolate?: boolean;
  metadata?: Record<string, unknown>;
}

export interface WorkflowSpec {
  mode: WorkflowMode;
  tasks: WorkflowTask[];
  maxConcurrency?: number;
  failurePolicy?: WorkflowFailurePolicy;
}

export interface WorkflowPlan {
  mode: WorkflowMode;
  tasks: WorkflowTask[];
  maxConcurrency: number;
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
  error?: string;
}

export interface WorkflowRunnerContext {
  task: WorkflowTask;
  attempt: number;
  dependencyResults: Record<string, WorkflowTaskRunResult>;
  pipelineInput?: WorkflowTaskRunResult;
}

export type WorkflowRunner = (
  context: WorkflowRunnerContext,
) => Promise<WorkflowWorkerResult> | WorkflowWorkerResult;

export interface WorkflowRunResult {
  status: "completed" | "failed";
  summary: string;
  plan: WorkflowPlan;
  results: Record<string, WorkflowTaskRunResult>;
  orderedResults: WorkflowTaskRunResult[];
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
  error?: string;
}

export interface WorkflowNotification {
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
  validateWorkflowTasks(tasks);
  const dependencyMap = buildDependencyMap(tasks);
  const dependentsMap = buildDependentsMap(tasks);
  const executionOrder = topologicalOrder(tasks, dependencyMap);

  return {
    mode: spec.mode,
    tasks,
    maxConcurrency: resolveMaxConcurrency(spec.mode, spec.maxConcurrency),
    executionOrder,
    dependencyMap,
    dependentsMap,
  };
}

export function createWorkflowNotification(result: WorkflowRunResult): WorkflowNotification {
  const completedTasks = result.orderedResults.filter((task) => task.status === "completed").length;
  return {
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

export async function runWorkflow(
  spec: WorkflowSpec,
  runner: WorkflowRunner,
): Promise<WorkflowRunResult> {
  const plan = createWorkflowPlan(spec);
  const failurePolicy = spec.failurePolicy ?? "skip-dependents";
  const results = new Map<string, WorkflowTaskRunResult>();
  const running = new Set<string>();
  const ready = plan.executionOrder.filter((taskId) => plan.dependencyMap[taskId]?.length === 0);
  let failFastTriggered = false;

  await new Promise<void>((resolve) => {
    const maybeResolve = () => {
      if (results.size === plan.tasks.length) resolve();
    };

    const skipTask = (taskId: string, reason: string) => {
      if (results.has(taskId) || running.has(taskId)) return;
      removeReady(ready, taskId);
      const now = Date.now();
      const task = requireWorkflowTask(plan.tasks, taskId);
      results.set(taskId, {
        taskId,
        status: "skipped",
        summary: reason,
        attempts: 0,
        dependencies: [...(task.dependsOn ?? [])],
        startedAt: now,
        finishedAt: now,
        skippedReason: reason,
      });
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

    const onFinished = (result: WorkflowTaskRunResult) => {
      running.delete(result.taskId);
      results.set(result.taskId, result);

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
        const taskId = ready.shift();
        if (!taskId || results.has(taskId) || running.has(taskId)) continue;
        const task = requireWorkflowTask(plan.tasks, taskId);
        running.add(taskId);
        runWorkflowTask(task, runner, collectDependencyResults(task, results), pipelineInputFor(plan, task, results))
          .then(onFinished);
      }
    };

    scheduleMore();
    maybeResolve();
  });

  return aggregateWorkflowResult(plan, results);
}

async function runWorkflowTask(
  task: WorkflowTask,
  runner: WorkflowRunner,
  dependencyResults: Record<string, WorkflowTaskRunResult>,
  pipelineInput: WorkflowTaskRunResult | undefined,
): Promise<WorkflowTaskRunResult> {
  const retry = normalizeRetry(task.retry);
  const startedAt = Date.now();
  let lastResult: WorkflowWorkerResult | undefined;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    try {
      lastResult = await runner({ task, attempt, dependencyResults, pipelineInput });
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
      if (!retry.retryOn.includes("failed") || attempt === retry.maxAttempts) {
        return {
          taskId: task.id,
          status: "failed",
          summary: lastError,
          attempts: attempt,
          dependencies: [...(task.dependsOn ?? [])],
          startedAt,
          finishedAt: Date.now(),
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

function aggregateWorkflowResult(
  plan: WorkflowPlan,
  results: Map<string, WorkflowTaskRunResult>,
): WorkflowRunResult {
  const orderedResults = plan.executionOrder
    .map((taskId) => results.get(taskId))
    .filter((result): result is WorkflowTaskRunResult => result !== undefined);
  const completed = orderedResults.filter((result) => result.status === "completed").length;
  const failed = orderedResults.length - completed;
  return {
    status: failed === 0 ? "completed" : "failed",
    summary: `${completed}/${plan.tasks.length} tasks completed`,
    plan,
    results: Object.fromEntries(orderedResults.map((result) => [result.taskId, result])),
    orderedResults,
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
