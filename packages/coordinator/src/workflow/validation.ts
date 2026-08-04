import {
  resolveWorkflowBudgetPolicy,
  validateWorkflowBudgetPolicy,
  validateWorkflowBudgetPolicyPreset,
} from "./budget.js";
import type {
  WorkflowMode,
  WorkflowPlan,
  WorkflowSpec,
  WorkflowTask,
  WorkflowValidationReport,
} from "./model.js";

export function createWorkflowPlan(spec: WorkflowSpec): WorkflowPlan {
  const tasks = normalizeTasksForMode(spec.mode, spec.tasks);
  validateWorkflowTimeouts(spec.defaultTaskTimeoutMs, tasks);
  validateWorkflowBudgetPolicyPreset(spec.budgetPolicyPreset);
  const budgetPolicy = resolveWorkflowBudgetPolicy(spec.budgetPolicyPreset, spec.budgetPolicy);
  validateWorkflowBudgetPolicy(budgetPolicy);
  validateWorkflowTasks(tasks);
  const dependencyMap = buildDependencyMap(tasks);
  const dependentsMap = buildDependentsMap(tasks);
  const executionOrder = topologicalOrder(tasks, dependencyMap);

  return {
    mode: spec.mode,
    tasks,
    maxConcurrency: resolveMaxConcurrency(spec.mode, spec.maxConcurrency),
    defaultTaskTimeoutMs: spec.defaultTaskTimeoutMs,
    budgetPolicyPreset: spec.budgetPolicyPreset,
    budgetPolicy,
    executionOrder,
    dependencyMap,
    dependentsMap,
  };
}

export function createWorkflowValidationReport(spec: WorkflowSpec): WorkflowValidationReport {
  try {
    const plan = createWorkflowPlan(spec);
    const issues: WorkflowValidationReport["issues"] = [];
    for (let i = 0; i < plan.tasks.length; i += 1) {
      const left = plan.tasks[i]!;
      for (const right of plan.tasks.slice(i + 1)) {
        if (!workflowTasksConflict(left, right)) continue;
        issues.push({
          severity: "warning",
          code: "write-scope-overlap",
          message: `Tasks '${left.id}' and '${right.id}' have overlapping non-isolated write scopes and will be serialized.`,
          taskIds: [left.id, right.id],
        });
      }
    }
    return {
      valid: issues.every((issue) => issue.severity !== "error"),
      issues,
      plan,
    };
  } catch (error) {
    return {
      valid: false,
      issues: [{
        severity: "error",
        code: "invalid-workflow-spec",
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
}

export function validateWorkflowTasks(tasks: WorkflowTask[]): void {
  const seen = new Set<string>();
  for (const task of tasks) {
    const id = task.id.trim();
    if (!id) {
      throw new Error("Workflow task id cannot be empty");
    }
    if (seen.has(id)) throw new Error(`Duplicate workflow task id '${id}'`);
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

export function runnableWriteScopes(task: WorkflowTask): string[] {
  if (task.readOnly || task.isolate) return [];
  return (task.writeScope ?? []).map(normalizeWriteScope).filter((scope) => scope.length > 0);
}

export function normalizeWriteScope(scope: string): string {
  const normalized = scope.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
  return normalized === "." ? "" : normalized.toLowerCase();
}

export function writeScopesOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
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

function buildDependencyMap(tasks: WorkflowTask[]): Record<string, string[]> {
  return Object.fromEntries(tasks.map((task) => [task.id, [...(task.dependsOn ?? [])]]));
}

function buildDependentsMap(tasks: WorkflowTask[]): Record<string, string[]> {
  const dependents = Object.fromEntries(tasks.map((task) => [task.id, [] as string[]]));
  for (const task of tasks) {
    for (const dep of task.dependsOn ?? []) {
      dependents[dep]?.push(task.id);
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
