import type { ToolDefinition } from "@openharness/core";
import {
  formatWorkflowNotification,
  resumePersistentWorkflow,
  runWorkflow,
  runPersistentWorkflow,
  WorkflowRunStore,
  type WorkflowFailurePolicy,
  type WorkflowMode,
  type WorkflowRunEvent,
  type WorkflowRunSnapshot,
  type WorkflowRunner,
  type WorkflowSpec,
  type WorkflowTask,
} from "@openharness/coordinator";
import { createAgentWorkflowRunner } from "./workflow-runner";

const WORKFLOW_MODES = new Set<WorkflowMode>(["parallel", "sequential", "pipeline"]);
const FAILURE_POLICIES = new Set<WorkflowFailurePolicy>(["skip-dependents", "fail-fast", "continue"]);
const WORKFLOW_ACTIONS = new Set(["run", "resume", "status"]);

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
        action: {
          type: "string",
          enum: ["run", "resume", "status"],
          description: "Workflow action. Defaults to run. Use resume/status with runId or latest.",
        },
        view: {
          type: "string",
          enum: ["json", "timeline"],
          description: "For status, choose the default structured JSON payload or a readable timeline view.",
        },
        taskIds: {
          type: "array",
          items: { type: "string" },
          description: "For status timeline, include only events for these task ids.",
        },
        eventTypes: {
          type: "array",
          items: { type: "string" },
          description: "For status timeline, include only these event types.",
        },
        statuses: {
          type: "array",
          items: { type: "string" },
          description: "For status timeline, include only events with these statuses.",
        },
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
              timeoutSeconds: {
                type: "number",
                description: "Hard timeout for each attempt of this task, in seconds.",
              },
              readOnly: {
                type: "boolean",
                description: "Marks the task as read-only so it can run alongside write-scoped tasks.",
              },
              writeScope: {
                type: "array",
                items: { type: "string" },
                description: "Paths this non-isolated write task may modify; overlapping scopes are serialized.",
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
        defaultTaskTimeoutSeconds: {
          type: "number",
          description: "Default hard timeout for each task attempt, in seconds. Individual tasks can override it.",
        },
        budgetPolicy: {
          type: "object",
          properties: {
            maxTokensUsed: { type: "number", description: "Stop scheduling new work once known token usage reaches this value." },
            maxTimeUsedSeconds: { type: "number", description: "Stop scheduling new work once known task time usage reaches this value." },
            softMaxTokensUsed: { type: "number", description: "Enter soft budget mode once known token usage reaches this value." },
            softMaxTimeUsedSeconds: { type: "number", description: "Enter soft budget mode once known task time usage reaches this value." },
            onSoftLimit: {
              type: "string",
              enum: ["continue", "serialize", "conserve", "serialize-and-conserve"],
              description: "How to schedule remaining work after a soft budget is reached.",
            },
            conserve: {
              type: "object",
              properties: {
                promptHint: { type: "string", description: "Extra prompt guidance for workers started in budget conservation mode." },
                permissionMode: {
                  type: "string",
                  enum: ["default", "plan"],
                  description: "Permission mode override for conservation workers.",
                },
                maxTurns: { type: "number", description: "Max turns override for conservation workers." },
              },
            },
          },
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
        persist: {
          type: "boolean",
          description: "Persist workflow run snapshots under the project .openharness/workflows directory. Defaults to true.",
        },
        runId: {
          type: "string",
          description: "Optional stable workflow run id for persistence and recovery.",
        },
        latest: {
          type: "boolean",
          description: "For resume/status, use the latest persisted workflow run when runId is omitted.",
        },
      },
      required: [],
    },
    async execute(input, context) {
      const action = parseAction(input.action);
      if (!action) {
        return { content: [{ type: "text", text: "action must be one of: run, resume, status" }], isError: true };
      }

      if (action === "status") {
        return workflowStatus(input, context.cwd);
      }

      const specOrError = parseWorkflowSpec(input);
      if (action === "run" && typeof specOrError === "string") {
        return { content: [{ type: "text", text: specOrError }], isError: true };
      }

      try {
        const runner = createRunner({
          cwd: context.cwd,
          team: asOptionalString(input.team),
          timeoutMs: secondsToMs(input.timeoutSeconds, 300),
          permissionMode: parsePermissionMode(input.permissionMode),
        });
        const persist = input.persist !== false;
        const runId = asOptionalString(input.runId);
        const result = action === "resume"
          ? await workflowResume(input, context.cwd, runner as WorkflowRunner)
          : persist && options.run === undefined
            ? await runPersistentWorkflow(specOrError as WorkflowSpec, runner as WorkflowRunner, { cwd: context.cwd, runId })
            : runId
              ? await run(specOrError as WorkflowSpec, runner as WorkflowRunner, { runId })
              : await run(specOrError as WorkflowSpec, runner as WorkflowRunner);
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

function workflowStatus(input: Record<string, unknown>, cwd: string) {
  const store = new WorkflowRunStore({ cwd });
  const snapshot = loadWorkflowSnapshot(store, input);
  if (typeof snapshot === "string") {
    return { content: [{ type: "text" as const, text: snapshot }], isError: true };
  }
  const filters = parseTimelineFilters(input);
  const events = filterWorkflowEvents(store.loadEvents(snapshot.runId), filters);
  if (input.view === "timeline") {
    return { content: [{ type: "text" as const, text: formatWorkflowTimeline(snapshot, events, filters) }] };
  }
  return { content: [{ type: "text" as const, text: formatWorkflowSnapshot(snapshot, events, filters) }] };
}

async function workflowResume(
  input: Record<string, unknown>,
  cwd: string,
  runner: WorkflowRunner,
) {
  const store = new WorkflowRunStore({ cwd });
  const snapshot = loadWorkflowSnapshot(store, input);
  if (typeof snapshot === "string") {
    throw new Error(snapshot);
  }
  return resumePersistentWorkflow(snapshot, runner, { store });
}

function loadWorkflowSnapshot(
  store: WorkflowRunStore,
  input: Record<string, unknown>,
): WorkflowRunSnapshot | string {
  const runId = asOptionalString(input.runId);
  const snapshot = runId ? store.load(runId) : store.latest();
  if (!snapshot) {
    return runId ? `Workflow run not found: ${runId}` : "No workflow runs found";
  }
  return snapshot;
}

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
  const defaultTaskTimeoutMs = secondsToOptionalMs(input.defaultTaskTimeoutSeconds);
  if (defaultTaskTimeoutMs === "invalid") {
    return "defaultTaskTimeoutSeconds must be a positive number";
  }
  const budgetPolicyOrError = parseBudgetPolicy(input.budgetPolicy);
  if (typeof budgetPolicyOrError === "string") return budgetPolicyOrError;

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
    ...(defaultTaskTimeoutMs !== undefined ? { defaultTaskTimeoutMs } : {}),
    ...(budgetPolicyOrError !== undefined ? { budgetPolicy: budgetPolicyOrError } : {}),
    ...(failurePolicy !== undefined ? { failurePolicy } : {}),
  };
}

function parseAction(value: unknown): "run" | "resume" | "status" | undefined {
  if (value === undefined) return "run";
  return typeof value === "string" && WORKFLOW_ACTIONS.has(value)
    ? value as "run" | "resume" | "status"
    : undefined;
}

function parseWorkflowTask(input: Record<string, unknown>, index: number): WorkflowTask | string {
  const id = input.id;
  if (typeof id !== "string" || id.trim() === "") {
    return `tasks[${index}].id must be a non-empty string`;
  }
  const retryOrError = parseRetry(input.retry, index);
  if (typeof retryOrError === "string") return retryOrError;
  const timeoutMs = secondsToOptionalMs(input.timeoutSeconds);
  if (timeoutMs === "invalid") {
    return `tasks[${index}].timeoutSeconds must be a positive number`;
  }

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
    timeoutMs,
    readOnly: typeof input.readOnly === "boolean" ? input.readOnly : undefined,
    writeScope: parseStringArray(input.writeScope),
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

function parseBudgetPolicy(input: unknown): WorkflowSpec["budgetPolicy"] | string {
  if (input === undefined) return undefined;
  if (!isRecord(input)) return "budgetPolicy must be an object";
  const maxTokensUsed = input.maxTokensUsed;
  const maxTimeUsedMs = secondsToOptionalMs(input.maxTimeUsedSeconds);
  const softMaxTokensUsed = input.softMaxTokensUsed;
  const softMaxTimeUsedMs = secondsToOptionalMs(input.softMaxTimeUsedSeconds);
  const onSoftLimit = input.onSoftLimit;
  const conserveOrError = parseConservePolicy(input.conserve);
  if (maxTokensUsed !== undefined && (typeof maxTokensUsed !== "number" || !Number.isFinite(maxTokensUsed) || maxTokensUsed <= 0)) {
    return "budgetPolicy.maxTokensUsed must be a positive number";
  }
  if (maxTimeUsedMs === "invalid") {
    return "budgetPolicy.maxTimeUsedSeconds must be a positive number";
  }
  if (softMaxTokensUsed !== undefined && (typeof softMaxTokensUsed !== "number" || !Number.isFinite(softMaxTokensUsed) || softMaxTokensUsed <= 0)) {
    return "budgetPolicy.softMaxTokensUsed must be a positive number";
  }
  if (softMaxTimeUsedMs === "invalid") {
    return "budgetPolicy.softMaxTimeUsedSeconds must be a positive number";
  }
  if (
    onSoftLimit !== undefined &&
    onSoftLimit !== "continue" &&
    onSoftLimit !== "serialize" &&
    onSoftLimit !== "conserve" &&
    onSoftLimit !== "serialize-and-conserve"
  ) {
    return "budgetPolicy.onSoftLimit must be one of: continue, serialize, conserve, serialize-and-conserve";
  }
  if (typeof conserveOrError === "string") return conserveOrError;
  return {
    ...(maxTokensUsed !== undefined ? { maxTokensUsed } : {}),
    ...(maxTimeUsedMs !== undefined ? { maxTimeUsedMs } : {}),
    ...(softMaxTokensUsed !== undefined ? { softMaxTokensUsed } : {}),
    ...(softMaxTimeUsedMs !== undefined ? { softMaxTimeUsedMs } : {}),
    ...(onSoftLimit !== undefined ? { onSoftLimit } : {}),
    ...(conserveOrError !== undefined ? { conserve: conserveOrError } : {}),
  };
}

function parseConservePolicy(input: unknown): NonNullable<WorkflowSpec["budgetPolicy"]>["conserve"] | string {
  if (input === undefined) return undefined;
  if (!isRecord(input)) return "budgetPolicy.conserve must be an object";
  const promptHint = asOptionalString(input.promptHint);
  const permissionMode = input.permissionMode;
  const maxTurns = input.maxTurns;
  if (permissionMode !== undefined && permissionMode !== "default" && permissionMode !== "plan") {
    return "budgetPolicy.conserve.permissionMode must be one of: default, plan";
  }
  if (maxTurns !== undefined && (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns < 1)) {
    return "budgetPolicy.conserve.maxTurns must be a positive integer";
  }
  return {
    ...(promptHint !== undefined ? { promptHint } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
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

function secondsToOptionalMs(value: unknown): number | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "invalid";
  return Math.floor(value * 1000);
}

interface TimelineFilters {
  taskIds?: string[];
  eventTypes?: string[];
  statuses?: string[];
}

function parseTimelineFilters(input: Record<string, unknown>): TimelineFilters {
  return {
    taskIds: parseStringArray(input.taskIds),
    eventTypes: parseStringArray(input.eventTypes),
    statuses: parseStringArray(input.statuses),
  };
}

function filterWorkflowEvents(events: WorkflowRunEvent[], filters: TimelineFilters): WorkflowRunEvent[] {
  return events.filter((event) => {
    if (filters.taskIds && (!event.taskId || !filters.taskIds.includes(event.taskId))) return false;
    if (filters.eventTypes && !filters.eventTypes.includes(event.type)) return false;
    if (filters.statuses && (!event.status || typeof event.status !== "string" || !filters.statuses.includes(event.status))) return false;
    return true;
  });
}

function formatWorkflowSnapshot(snapshot: WorkflowRunSnapshot, events: WorkflowRunEvent[] = [], filters: TimelineFilters = {}): string {
  const timeline = createWorkflowTimeline(events);
  const timelineControls = createTimelineControls(snapshot, events);
  const timelineSummary = createTimelineSummary(timeline);
  return [
    "<workflow-run-snapshot>",
    `<payload>${escapeXml(JSON.stringify({ snapshot, events, filters, timelineControls, timelineSummary, timeline, timelineText: formatTimelineText(snapshot, timeline, filters, timelineSummary) }))}</payload>`,
    "</workflow-run-snapshot>",
  ].join("\n");
}

function formatWorkflowTimeline(snapshot: WorkflowRunSnapshot, events: WorkflowRunEvent[], filters: TimelineFilters = {}): string {
  const timeline = createWorkflowTimeline(events);
  return formatTimelineText(snapshot, timeline, filters, createTimelineSummary(timeline));
}

function createWorkflowTimeline(events: WorkflowRunEvent[]): Array<{ timestamp: number; type: string; taskId?: string; status?: string; summary: string }> {
  return events.map((event) => ({
    timestamp: event.timestamp,
    type: event.type,
    taskId: event.taskId,
    status: typeof event.status === "string" ? event.status : undefined,
    summary: event.summary ?? event.result?.summary ?? event.blockedTask?.reason ?? event.type,
  }));
}

function formatTimelineText(
  snapshot: WorkflowRunSnapshot,
  timeline: Array<{ timestamp: number; type: string; taskId?: string; status?: string; summary: string }>,
  filters: TimelineFilters = {},
  summary = createTimelineSummary(timeline),
): string {
  const lines = [
    `Workflow ${snapshot.runId} (${snapshot.status})`,
    snapshot.summary,
    `Events: ${summary.total} total; ${Object.entries(summary.byType).map(([type, count]) => `${type}=${count}`).join(" ")}`,
  ];
  const filterText = formatTimelineFilters(filters);
  if (filterText) lines.push(filterText);
  for (const event of timeline) {
    const task = event.taskId ? ` ${event.taskId}` : "";
    const status = event.status ? ` [${event.status}]` : "";
    lines.push(`- ${new Date(event.timestamp).toISOString()} ${event.type}${task}${status}: ${event.summary}`);
  }
  return lines.join("\n");
}

function createTimelineControls(snapshot: WorkflowRunSnapshot, events: WorkflowRunEvent[]) {
  return {
    taskIds: [...new Set([...snapshot.plan.tasks.map((task) => task.id), ...events.map((event) => event.taskId).filter((id): id is string => id !== undefined)])].sort(),
    eventTypes: [...new Set(events.map((event) => event.type))].sort(),
    statuses: [...new Set(events.map((event) => event.status).filter((status) => typeof status === "string").map(String))].sort(),
  };
}

function createTimelineSummary(
  timeline: Array<{ timestamp: number; type: string; taskId?: string; status?: string; summary: string }>,
) {
  return {
    total: timeline.length,
    byType: countBy(timeline.map((event) => event.type)),
    byStatus: countBy(timeline.map((event) => event.status).filter((status): status is string => status !== undefined)),
    byTaskId: countBy(timeline.map((event) => event.taskId).filter((taskId): taskId is string => taskId !== undefined)),
  };
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function formatTimelineFilters(filters: TimelineFilters): string | undefined {
  const parts = [
    filters.taskIds ? `taskIds=${filters.taskIds.join(",")}` : undefined,
    filters.eventTypes ? `eventTypes=${filters.eventTypes.join(",")}` : undefined,
    filters.statuses ? `statuses=${filters.statuses.join(",")}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? `Filters: ${parts.join(" ")}` : undefined;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
