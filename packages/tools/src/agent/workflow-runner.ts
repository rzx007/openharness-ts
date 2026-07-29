import type {
  AgentDefinition,
  WorkflowRunner,
  WorkflowTask,
  WorkflowWorkerResult,
} from "@openharness/coordinator";
import { execFile } from "node:child_process";
import type { AwaitTaskResult } from "@openharness/services";
import type { SpawnResult, TeammateSpawnConfig } from "@openharness/swarm";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AgentWorkflowRunnerOptions {
  cwd: string;
  team?: string;
  mode?: "local_agent" | "remote_agent" | "in_process_teammate";
  timeoutMs?: number;
  permissionMode?: "default" | "plan" | "full_auto";
  fromAgent?: string;
  spawnWorker?: (config: TeammateSpawnConfig) => Promise<SpawnResult>;
  awaitTask?: (taskId: string, options?: { timeoutMs?: number }) => Promise<AwaitTaskResult>;
  getChangedFiles?: (cwd: string) => Promise<string[]>;
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
  return async ({ task, attempt, dependencyResults, pipelineInput, resumeFrom, budgetMode, reportProgress }) => {
    const prompt = buildWorkerPrompt(task, dependencyResults, pipelineInput, budgetMode);
    const subagentType = task.subagentType ?? "worker";
    const agentDef = options.getAgentDefinition
      ? options.getAgentDefinition(subagentType)
      : await defaultGetAgentDefinition(subagentType);
    const team = task.team ?? options.team ?? "default";
    const workerSessionId = createWorkerSessionId(task.id, attempt);
    const spawnWorker = options.spawnWorker ?? defaultSpawnWorker;
    const awaitTask = options.awaitTask ?? defaultAwaitTask;

    const resumedTaskId = getStringMetadata(resumeFrom?.metadata, "taskManagerTaskId");
    if (resumedTaskId) {
      try {
        reportProgress?.({
          summary: `Waiting for existing task ${resumedTaskId}`,
          metadata: resumeFrom?.metadata,
        });
        const waited = await awaitTask(resumedTaskId, { timeoutMs: options.timeoutMs });
        const spawn = {
          success: true,
          agentId: getStringMetadata(resumeFrom?.metadata, "agentId") ?? `${subagentType}@${team}`,
          taskId: resumedTaskId,
          backendType: getStringMetadata(resumeFrom?.metadata, "backendType") ?? "resumed",
          worktree: getWorktreeMetadata(resumeFrom?.metadata),
          notice: getStringMetadata(resumeFrom?.metadata, "notice"),
        } satisfies SpawnResult;
        const changedFiles = await getChangedFilesForWorker(options, spawn);
        return mapAwaitedTaskToWorkerResult(task, spawn, waited, changedFiles);
      } catch (error) {
        reportProgress?.({
          summary: `Existing task ${resumedTaskId} unavailable; spawning replacement`,
          metadata: {
            ...resumeFrom?.metadata,
            resumeError: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

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

    reportProgress?.({
      summary: `Waiting for task ${spawn.taskId}`,
      metadata: spawnMetadata(spawn),
    });
    const waited = await awaitTask(spawn.taskId, { timeoutMs: options.timeoutMs });
    const changedFiles = await getChangedFilesForWorker(options, spawn);
    return mapAwaitedTaskToWorkerResult(task, spawn, waited, changedFiles);
  };
}

function buildWorkerPrompt(
  task: WorkflowTask,
  dependencyResults: Record<string, { status: string; summary: string; result?: string }>,
  pipelineInput: { status: string; summary: string; result?: string } | undefined,
  budgetMode: "normal" | "conserve" | undefined,
): string {
  const parts = [task.prompt ?? task.description ?? task.id];
  if (budgetMode === "conserve") {
    parts.push("\nBudget conservation mode: keep the response concise, avoid broad exploration, and prefer read-only verification unless edits are essential.");
  }
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
  changedFiles: string[] = [],
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
      ...(changedFiles.length > 0 ? { changedFiles } : {}),
      ...(waited.timedOut ? { timedOut: true } : {}),
    },
  };
}

function spawnMetadata(spawn: SpawnResult): Record<string, unknown> {
  return {
    agentId: spawn.agentId,
    taskManagerTaskId: spawn.taskId,
    backendType: spawn.backendType,
    ...(spawn.worktree ? { worktree: spawn.worktree } : {}),
    ...(spawn.notice ? { notice: spawn.notice } : {}),
  };
}

function getStringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function getWorktreeMetadata(metadata: Record<string, unknown> | undefined): SpawnResult["worktree"] | undefined {
  const value = metadata?.worktree;
  if (!value || typeof value !== "object") return undefined;
  const worktree = value as { path?: unknown; branch?: unknown };
  return typeof worktree.path === "string" && typeof worktree.branch === "string"
    ? { path: worktree.path, branch: worktree.branch }
    : undefined;
}

async function getChangedFilesForWorker(
  options: AgentWorkflowRunnerOptions,
  spawn: SpawnResult,
): Promise<string[]> {
  const cwd = spawn.worktree?.path ?? options.cwd;
  const getChangedFiles = options.getChangedFiles ?? defaultGetChangedFiles;
  try {
    return normalizeChangedFiles(await getChangedFiles(cwd));
  } catch {
    return [];
  }
}

async function defaultGetChangedFiles(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, "status", "--porcelain", "--untracked-files=all"], {
    windowsHide: true,
  });
  return parseGitStatusPorcelain(stdout);
}

function parseGitStatusPorcelain(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3).split(" -> ").pop() ?? line.slice(3))
    .filter((file) => file.length > 0);
}

function normalizeChangedFiles(files: string[]): string[] {
  return [...new Set(files.map((file) => file.trim().replace(/\\/g, "/")).filter((file) => file.length > 0))].sort();
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
