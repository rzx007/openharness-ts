import type {
  AgentDefinition,
  WorkflowRunner,
  WorkflowTask,
  WorkflowWorkerResult,
} from "@openharness/coordinator";
import type { AwaitTaskResult } from "@openharness/services";
import type { SpawnResult, TeammateSpawnConfig } from "@openharness/swarm";

export interface AgentWorkflowRunnerOptions {
  cwd: string;
  team?: string;
  mode?: "local_agent" | "remote_agent" | "in_process_teammate";
  timeoutMs?: number;
  permissionMode?: "default" | "plan" | "full_auto";
  fromAgent?: string;
  spawnWorker?: (config: TeammateSpawnConfig) => Promise<SpawnResult>;
  awaitTask?: (taskId: string, options?: { timeoutMs?: number }) => Promise<AwaitTaskResult>;
  getAgentDefinition?: (name: string) => AgentDefinition | undefined;
}

/**
 * Build a WorkflowRunner that executes each workflow task as a real swarm
 * worker and waits for the corresponding TaskManager task to finish.
 *
 * This lives in @openharness/tools, not @openharness/coordinator, so the
 * coordinator package can stay a pure scheduler with no dependency on services
 * or swarm.
 */
export function createAgentWorkflowRunner(options: AgentWorkflowRunnerOptions): WorkflowRunner {
  return async ({ task, attempt, dependencyResults, pipelineInput }) => {
    const prompt = buildWorkerPrompt(task, dependencyResults, pipelineInput);
    const subagentType = task.subagentType ?? "worker";
    const agentDef = options.getAgentDefinition
      ? options.getAgentDefinition(subagentType)
      : await defaultGetAgentDefinition(subagentType);
    const team = task.team ?? options.team ?? "default";
    const workerSessionId = createWorkerSessionId(task.id, attempt);
    const spawnWorker = options.spawnWorker ?? defaultSpawnWorker;

    const spawn = await spawnWorker({
      name: subagentType,
      team,
      prompt,
      cwd: options.cwd,
      parentSessionId: "main",
      sessionId: workerSessionId,
      model: task.model ?? agentDef?.model,
      systemPrompt: agentDef?.systemPrompt,
      permissionMode: normalizePermissionMode(
        task.permissionMode ?? options.permissionMode ?? agentDef?.permissionMode,
      ),
      isolate: task.isolate === true,
      allowedTools: agentDef?.tools,
      disallowedTools: agentDef?.disallowedTools,
      maxTurns: agentDef?.maxTurns,
      effort: agentDef?.effort != null ? String(agentDef.effort) : undefined,
    });

    if (!spawn.success) {
      return {
        status: "failed",
        summary: spawn.error ?? "Failed to spawn workflow worker",
        metadata: {
          agentId: spawn.agentId,
          taskManagerTaskId: spawn.taskId,
          backendType: spawn.backendType,
        },
      };
    }

    const awaitTask = options.awaitTask ?? defaultAwaitTask;
    const waited = await awaitTask(spawn.taskId, { timeoutMs: options.timeoutMs });
    return mapAwaitedTaskToWorkerResult(task, spawn, waited);
  };
}

function buildWorkerPrompt(
  task: WorkflowTask,
  dependencyResults: Record<string, { status: string; summary: string; result?: string }>,
  pipelineInput: { status: string; summary: string; result?: string } | undefined,
): string {
  const parts = [task.prompt ?? task.description ?? task.id];
  const dependencyEntries = Object.entries(dependencyResults);
  if (dependencyEntries.length > 0) {
    parts.push(
      "\nDependency results:",
      ...dependencyEntries.map(([taskId, result]) => formatDependencyResult(taskId, result)),
    );
  }
  if (pipelineInput) {
    parts.push("\nPipeline input:", formatDependencyResult("previous", pipelineInput));
  }
  return parts.join("\n");
}

function formatDependencyResult(
  taskId: string,
  result: { status: string; summary: string; result?: string },
): string {
  const lines = [`- ${taskId}: ${result.status} - ${result.summary}`];
  if (result.result) {
    lines.push(indentBlock(result.result));
  }
  return lines.join("\n");
}

function indentBlock(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}

function mapAwaitedTaskToWorkerResult(
  task: WorkflowTask,
  spawn: SpawnResult,
  waited: AwaitTaskResult,
): WorkflowWorkerResult {
  const status = waited.timedOut
    ? "failed"
    : waited.status === "completed"
      ? "completed"
      : waited.status === "stopped"
        ? "killed"
        : "failed";
  const detail = waited.timedOut
    ? `did not finish before timeout`
    : waited.exitCode != null
      ? `finished with exit code ${waited.exitCode}`
      : `finished with status ${waited.status}`;
  return {
    status,
    summary: `${task.id} ${detail}`,
    result: waited.output,
    metadata: {
      agentId: spawn.agentId,
      taskManagerTaskId: spawn.taskId,
      backendType: spawn.backendType,
      ...(spawn.worktree ? { worktree: spawn.worktree } : {}),
      ...(spawn.notice ? { notice: spawn.notice } : {}),
      ...(waited.timedOut ? { timedOut: true } : {}),
    },
  };
}

async function defaultSpawnWorker(config: TeammateSpawnConfig): Promise<SpawnResult> {
  const { getBackendRegistry } = await import("@openharness/swarm");
  const registry = getBackendRegistry();
  try {
    return await registry.getExecutor("in_process").spawn(config);
  } catch {
    try {
      return await registry.getExecutor("subprocess").spawn(config);
    } catch {
      return await registry.getExecutor().spawn(config);
    }
  }
}

async function defaultAwaitTask(
  taskId: string,
  options?: { timeoutMs?: number },
): Promise<AwaitTaskResult> {
  const { getTaskManager } = await import("@openharness/services");
  return getTaskManager().awaitTask(taskId, options);
}

async function defaultGetAgentDefinition(name: string): Promise<AgentDefinition | undefined> {
  const { getAgentDefinition } = await import("@openharness/coordinator");
  return getAgentDefinition(name);
}

function createWorkerSessionId(taskId: string, attempt: number): string {
  const rand = Math.random().toString(36).slice(2, 7);
  return `wf-${taskId}-${attempt}-${Date.now().toString(36)}-${rand}`;
}

function normalizePermissionMode(
  value: string | undefined,
): "default" | "plan" | "full_auto" | undefined {
  if (value === "default" || value === "plan" || value === "full_auto") {
    return value;
  }
  return undefined;
}
