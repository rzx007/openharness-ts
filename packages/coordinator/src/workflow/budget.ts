import { WORKFLOW_BUDGET_POLICY_PRESETS } from "./model.js";
import type {
  WorkflowBudgetPolicy,
  WorkflowBudgetPolicyPreset,
  WorkflowBudgetUsage,
  WorkflowRunningTask,
  WorkflowTaskBudgetUsage,
  WorkflowTaskRunResult,
} from "./model.js";

export function validateWorkflowBudgetPolicy(policy: WorkflowBudgetPolicy | undefined): void {
  if (!policy) return;
  validateBudgetPolicyNumber(policy.maxTokensUsed, "budgetPolicy.maxTokensUsed");
  validateBudgetPolicyNumber(policy.maxTimeUsedMs, "budgetPolicy.maxTimeUsedMs");
  validateBudgetPolicyNumber(policy.softMaxTokensUsed, "budgetPolicy.softMaxTokensUsed");
  validateBudgetPolicyNumber(policy.softMaxTimeUsedMs, "budgetPolicy.softMaxTimeUsedMs");
  if (
    policy.onSoftLimit !== undefined &&
    policy.onSoftLimit !== "continue" &&
    policy.onSoftLimit !== "serialize" &&
    policy.onSoftLimit !== "conserve" &&
    policy.onSoftLimit !== "serialize-and-conserve"
  ) {
    throw new Error("budgetPolicy.onSoftLimit must be one of: continue, serialize, conserve, serialize-and-conserve");
  }
  if (policy.conserve?.maxTurns !== undefined && (!Number.isInteger(policy.conserve.maxTurns) || policy.conserve.maxTurns < 1)) {
    throw new Error("budgetPolicy.conserve.maxTurns must be a positive integer");
  }
  if (
    policy.conserve?.permissionMode !== undefined &&
    policy.conserve.permissionMode !== "default" &&
    policy.conserve.permissionMode !== "plan"
  ) {
    throw new Error("budgetPolicy.conserve.permissionMode must be one of: default, plan");
  }
}

export function validateWorkflowBudgetPolicyPreset(preset: WorkflowBudgetPolicyPreset | undefined): void {
  if (preset === undefined) return;
  if (!(preset in WORKFLOW_BUDGET_POLICY_PRESETS)) {
    throw new Error("budgetPolicyPreset must be one of: cheap-review, safe-write, fast-parallel");
  }
}

export function resolveWorkflowBudgetPolicy(
  preset: WorkflowBudgetPolicyPreset | undefined,
  policy: WorkflowBudgetPolicy | undefined,
): WorkflowBudgetPolicy | undefined {
  if (!preset) return policy;
  return mergeWorkflowBudgetPolicy(WORKFLOW_BUDGET_POLICY_PRESETS[preset], policy);
}

export function workflowBudgetFromMetadata(metadata: Record<string, unknown> | undefined): WorkflowTaskBudgetUsage | undefined {
  if (!metadata) return undefined;
  const budget = isRecord(metadata.budget) ? metadata.budget : metadata;
  return normalizeBudgetUsage({
    tokensUsed: budget.tokensUsed,
    tokenBudget: budget.tokenBudget,
    timeUsedMs: budget.timeUsedMs,
    timeBudgetMs: budget.timeBudgetMs,
  });
}

export function collectWorkflowBudgetUsage(
  orderedResults: WorkflowTaskRunResult[],
  runningTasks: WorkflowRunningTask[] = [],
): WorkflowBudgetUsage {
  const tasks: Record<string, WorkflowTaskBudgetUsage> = {};
  for (const result of orderedResults) {
    const budget = result.budget ?? workflowBudgetFromMetadata(result.metadata);
    if (budget) tasks[result.taskId] = budget;
  }
  for (const task of runningTasks) {
    const budget = task.budget ?? workflowBudgetFromMetadata(task.metadata);
    if (budget) tasks[task.taskId] = budget;
  }

  return {
    tasks,
    tokensUsed: sumBudget(tasks, "tokensUsed"),
    tokenBudget: sumBudget(tasks, "tokenBudget"),
    timeUsedMs: sumBudget(tasks, "timeUsedMs"),
    timeBudgetMs: sumBudget(tasks, "timeBudgetMs"),
  };
}

export function workflowBudgetPolicyExceeded(
  policy: WorkflowBudgetPolicy | undefined,
  budget: WorkflowBudgetUsage,
): string | undefined {
  if (!policy) return undefined;
  if (policy.maxTokensUsed !== undefined && (budget.tokensUsed ?? 0) >= policy.maxTokensUsed) {
    return `Skipped because workflow token budget exceeded (${budget.tokensUsed ?? 0}/${policy.maxTokensUsed})`;
  }
  if (policy.maxTimeUsedMs !== undefined && (budget.timeUsedMs ?? 0) >= policy.maxTimeUsedMs) {
    return `Skipped because workflow time budget exceeded (${budget.timeUsedMs ?? 0}/${policy.maxTimeUsedMs}ms)`;
  }
  return undefined;
}

export function workflowBudgetSoftLimit(
  policy: WorkflowBudgetPolicy | undefined,
  budget: WorkflowBudgetUsage,
): { summary: string; serialize: boolean; conserve: boolean } | undefined {
  if (!policy) return undefined;
  const reason =
    policy.softMaxTokensUsed !== undefined && (budget.tokensUsed ?? 0) >= policy.softMaxTokensUsed
      ? `Workflow token soft budget reached (${budget.tokensUsed ?? 0}/${policy.softMaxTokensUsed})`
      : policy.softMaxTimeUsedMs !== undefined && (budget.timeUsedMs ?? 0) >= policy.softMaxTimeUsedMs
        ? `Workflow time soft budget reached (${budget.timeUsedMs ?? 0}/${policy.softMaxTimeUsedMs}ms)`
        : undefined;
  if (!reason) return undefined;
  const action = policy.onSoftLimit ?? "serialize-and-conserve";
  return {
    summary: `${reason}; applying ${action}`,
    serialize: action === "serialize" || action === "serialize-and-conserve",
    conserve: action === "conserve" || action === "serialize-and-conserve",
  };
}

export function cloneBudgetUsage(budget: WorkflowTaskBudgetUsage | undefined): WorkflowTaskBudgetUsage | undefined {
  return budget ? { ...budget } : undefined;
}

function mergeWorkflowBudgetPolicy(
  presetPolicy: WorkflowBudgetPolicy,
  policy: WorkflowBudgetPolicy | undefined,
): WorkflowBudgetPolicy {
  if (!policy) {
    return cloneWorkflowBudgetPolicy(presetPolicy);
  }
  return {
    ...cloneWorkflowBudgetPolicy(presetPolicy),
    ...policy,
    conserve: presetPolicy.conserve || policy.conserve
      ? {
          ...presetPolicy.conserve,
          ...policy.conserve,
        }
      : undefined,
  };
}

function cloneWorkflowBudgetPolicy(policy: WorkflowBudgetPolicy): WorkflowBudgetPolicy {
  return {
    ...policy,
    conserve: policy.conserve ? { ...policy.conserve } : undefined,
  };
}

function validateBudgetPolicyNumber(value: number | undefined, label: string): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
}

function normalizeBudgetUsage(input: Record<keyof WorkflowTaskBudgetUsage, unknown>): WorkflowTaskBudgetUsage | undefined {
  const budget: WorkflowTaskBudgetUsage = {};
  if (typeof input.tokensUsed === "number" && Number.isFinite(input.tokensUsed)) budget.tokensUsed = input.tokensUsed;
  if (typeof input.tokenBudget === "number" && Number.isFinite(input.tokenBudget)) budget.tokenBudget = input.tokenBudget;
  if (typeof input.timeUsedMs === "number" && Number.isFinite(input.timeUsedMs)) budget.timeUsedMs = input.timeUsedMs;
  if (typeof input.timeBudgetMs === "number" && Number.isFinite(input.timeBudgetMs)) budget.timeBudgetMs = input.timeBudgetMs;
  return Object.keys(budget).length > 0 ? budget : undefined;
}

function sumBudget(
  tasks: Record<string, WorkflowTaskBudgetUsage>,
  field: keyof WorkflowTaskBudgetUsage,
): number | undefined {
  const values = Object.values(tasks)
    .map((budget) => budget[field])
    .filter((value): value is number => typeof value === "number");
  return values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
