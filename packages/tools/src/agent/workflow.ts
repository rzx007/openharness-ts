import type { ToolDefinition } from "@openharness/core";
import {
  formatWorkflowNotification,
  runWorkflow,
  type WorkflowFailurePolicy,
  type WorkflowMode,
  type WorkflowRunner,
  type WorkflowSpec,
  type WorkflowTask,
} from "@openharness/coordinator";
import { createAgentWorkflowRunner } from "./workflow-runner";

const WORKFLOW_MODES = new Set<WorkflowMode>(["parallel", "sequential", "pipeline"]);
const FAILURE_POLICIES = new Set<WorkflowFailurePolicy>(["skip-dependents", "fail-fast", "continue"]);

export interface WorkflowToolOptions {
  createRunner?: typeof createAgentWorkflowRunner;
  run?: typeof runWorkflow;
}

export function createWorkflowTool(options: WorkflowToolOptions = {}): ToolDefinition {
  const createRunner = options.createRunner ?? createAgentWorkflowRunner;
  const run = options.run ?? runWorkflow;

  return {
    name: "Workflow",
    description:
      "Run a hard-scheduled multi-agent workflow. Use this when work has an explicit DAG, " +
      "sequential steps, a pipeline, retries, failure policy, or concurrency limits. " +
      "For one-off delegation, Agent plus TaskWait is still simpler.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["parallel", "sequential", "pipeline"],
          description: "Scheduling mode. parallel honors dependsOn; sequential/pipeline chain tasks in order.",
        },
        tasks: {
          type: "array",
          description: "Workflow tasks. Each task normally becomes one spawned sub-agent.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable task id used by dependsOn" },
              description: { type: "string", description: "Short task description" },
              prompt: { type: "string", description: "Full prompt for this worker" },
              subagentType: { type: "string", description: "Agent type, such as Explore, worker, or a custom subagent" },
              model: { type: "string", description: "Model override" },
              team: { type: "string", description: "Optional team to attach the worker to" },
              permissionMode: {
                type: "string",
                enum: ["default", "plan", "full_auto"],
                description: "Worker permission mode",
              },
              dependsOn: {
                type: "array",
                items: { type: "string" },
                description: "Task ids that must finish before this task can run",
              },
              retry: {
                type: "object",
                properties: {
                  maxAttempts: { type: "number", description: "Total attempts including the first attempt" },
                  retryOn: {
                    type: "array",
                    items: { type: "string", enum: ["failed", "killed"] },
                    description: "Terminal statuses that should be retried",
                  },
                },
              },
              isolate: {
                type: "boolean",
                description: "Run worker in an isolated worktree when the backend supports it",
              },
            },
            required: ["id"],
          },
        },
        maxConcurrency: {
          type: "number",
          description: "Parallel worker limit. Ignored by sequential and pipeline modes.",
        },
        failurePolicy: {
          type: "string",
          enum: ["skip-dependents", "fail-fast", "continue"],
          description: "How to react when a task fails. Defaults to skip-dependents.",
        },
        team: { type: "string", description: "Default team for tasks that do not set team" },
        timeoutSeconds: {
          type: "number",
          description: "Per-worker wait timeout in seconds. Defaults to 300.",
        },
        permissionMode: {
          type: "string",
          enum: ["default", "plan", "full_auto"],
          description: "Default permission mode for tasks that do not set permissionMode",
        },
      },
      required: ["mode", "tasks"],
    },
    async execute(input, context) {
      const specOrError = parseWorkflowSpec(input);
      if (typeof specOrError === "string") {
        return { content: [{ type: "text", text: specOrError }], isError: true };
      }

      try {
        const runner = createRunner({
          cwd: context.cwd,
          team: asOptionalString(input.team),
          timeoutMs: secondsToMs(input.timeoutSeconds, 300),
          permissionMode: parsePermissionMode(input.permissionMode),
        });
        const result = await run(specOrError, runner as WorkflowRunner);
        return {
          content: [{ type: "text", text: formatWorkflowNotification(result) }],
          ...(result.status === "failed" ? { isError: true } : {}),
        };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  };
}

export const workflowTool: ToolDefinition = createWorkflowTool();

function parseWorkflowSpec(input: Record<string, unknown>): WorkflowSpec | string {
  const mode = input.mode;
  if (!isWorkflowMode(mode)) {
    return "mode must be one of: parallel, sequential, pipeline";
  }
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    return "tasks must be a non-empty array";
  }

  const failurePolicy = input.failurePolicy;
  if (failurePolicy !== undefined && !isFailurePolicy(failurePolicy)) {
    return "failurePolicy must be one of: skip-dependents, fail-fast, continue";
  }

  const maxConcurrency = input.maxConcurrency;
  if (maxConcurrency !== undefined && typeof maxConcurrency !== "number") {
    return "maxConcurrency must be a number";
  }

  const tasks: WorkflowTask[] = [];
  for (const [index, rawTask] of input.tasks.entries()) {
    if (!isRecord(rawTask)) {
      return `tasks[${index}] must be an object`;
    }
    const taskOrError = parseWorkflowTask(rawTask, index);
    if (typeof taskOrError === "string") return taskOrError;
    tasks.push(taskOrError);
  }

  return {
    mode,
    tasks,
    ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
    ...(failurePolicy !== undefined ? { failurePolicy } : {}),
  };
}

function parseWorkflowTask(input: Record<string, unknown>, index: number): WorkflowTask | string {
  const id = input.id;
  if (typeof id !== "string" || id.trim() === "") {
    return `tasks[${index}].id must be a non-empty string`;
  }
  const retryOrError = parseRetry(input.retry, index);
  if (typeof retryOrError === "string") return retryOrError;

  return {
    id,
    description: asOptionalString(input.description),
    prompt: asOptionalString(input.prompt),
    subagentType: asOptionalString(input.subagentType),
    model: asOptionalString(input.model),
    team: asOptionalString(input.team),
    permissionMode: parsePermissionMode(input.permissionMode),
    dependsOn: parseStringArray(input.dependsOn),
    retry: retryOrError,
    isolate: typeof input.isolate === "boolean" ? input.isolate : undefined,
  };
}

function parseRetry(input: unknown, taskIndex: number): WorkflowTask["retry"] | string {
  if (input === undefined) return undefined;
  if (!isRecord(input)) return `tasks[${taskIndex}].retry must be an object`;
  const retryOn = parseStringArray(input.retryOn);
  const invalidRetryOn = retryOn?.find((status) => status !== "failed" && status !== "killed");
  if (invalidRetryOn) return `tasks[${taskIndex}].retry.retryOn contains invalid status '${invalidRetryOn}'`;
  const maxAttempts = input.maxAttempts;
  if (maxAttempts !== undefined && typeof maxAttempts !== "number") {
    return `tasks[${taskIndex}].retry.maxAttempts must be a number`;
  }
  return {
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(retryOn !== undefined ? { retryOn: retryOn as Array<"failed" | "killed"> } : {}),
  };
}

function isWorkflowMode(value: unknown): value is WorkflowMode {
  return typeof value === "string" && WORKFLOW_MODES.has(value as WorkflowMode);
}

function isFailurePolicy(value: unknown): value is WorkflowFailurePolicy {
  return typeof value === "string" && FAILURE_POLICIES.has(value as WorkflowFailurePolicy);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parsePermissionMode(value: unknown): "default" | "plan" | "full_auto" | undefined {
  if (value === "default" || value === "plan" || value === "full_auto") return value;
  return undefined;
}

function secondsToMs(value: unknown, defaultSeconds: number): number {
  return (typeof value === "number" ? value : defaultSeconds) * 1000;
}
