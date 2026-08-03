import { createHash, randomUUID } from "node:crypto";

import type { SpawnResult, SwarmBackend, TeammateMessage, TeammateSpawnConfig } from "./index.js";
import type { WorktreeManager } from "./worktree.js";

export interface ChildSessionHost {
  createChildSession(input: {
    id?: string;
    parentId: string;
    cwd: string;
    model?: string;
    title: string;
    agent: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string }>;
  admitPrompt(sessionId: string, content: string): Promise<{ runId?: string }>;
  awaitRun(
    sessionId: string,
    runId: string,
  ): Promise<{ status: "completed" | "failed" | "interrupted"; output: string; error?: string }>;
  interrupt(sessionId: string): Promise<void>;
  closeRuntime(sessionId: string): Promise<void>;
  archive(sessionId: string): Promise<void>;
}

export interface SessionTaskBridge {
  registerSessionTask(input: {
    description: string;
    cwd: string;
    sessionId: string;
    childSessionId: string;
    prompt: string;
    onInput(data: string): Promise<void>;
    onStop(): Promise<void>;
  }): { id: string };
  completeSessionTask(
    taskId: string,
    input: { status: "completed" | "failed" | "stopped" | "interrupted"; output: string },
  ): Promise<unknown>;
  /** Optional for legacy local task bridges; daemon bridges persist the linkage. */
  bindSessionTaskRun?(taskId: string, runId: string): Promise<void>;
  writeToSessionTask(taskId: string, data: string): Promise<void>;
}

export interface ChildSessionBackendOptions {
  host: ChildSessionHost;
  taskBridge: SessionTaskBridge;
  worktreeManager?: WorktreeManager;
  registerTeammate?: (config: TeammateSpawnConfig, result: SpawnResult) => void;
}

export class ChildSessionBackend implements SwarmBackend {
  readonly backendType = "in_process";
  private readonly children = new Map<string, { sessionId: string; taskId: string; worktreeSlug?: string }>();
  private readonly taskGenerations = new Map<string, number>();

  constructor(private options: ChildSessionBackendOptions) {}

  reconfigure(options: ChildSessionBackendOptions): void {
    this.options = options;
  }

  async spawn(config: TeammateSpawnConfig): Promise<SpawnResult> {
    const agentId = `${config.name}@${config.team}`;
    let effectiveConfig = config;
    let worktree: SpawnResult["worktree"];
    let worktreeSlug: string | undefined;
    let childSessionId: string | undefined;
    let taskId = "";
    try {
      if (config.isolate && this.options.worktreeManager && await this.options.worktreeManager.isGitRepo()) {
        const rawSlug = `${config.team}-${config.name}`
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, "-")
          .replace(/^-+|-+$/g, "") || "agent";
        const suffix = `${createHash("sha1").update(rawSlug).digest("hex").slice(0, 8)}-${randomUUID().slice(0, 8)}`;
        const slug = `${rawSlug.slice(0, 64 - suffix.length - 1)}-${suffix}`;
        const created = await this.options.worktreeManager.create(slug);
        worktree = { path: created.path, branch: created.branch };
        if (created.created) worktreeSlug = created.slug;
        effectiveConfig = { ...config, cwd: created.path };
      }

      const child = await this.options.host.createChildSession({
        id: effectiveConfig.sessionId,
        parentId: effectiveConfig.parentSessionId,
        cwd: effectiveConfig.cwd,
        ...(effectiveConfig.model ? { model: effectiveConfig.model } : {}),
        title: `${effectiveConfig.name}@${effectiveConfig.team}`,
        agent: effectiveConfig.name,
        metadata: {
          team: effectiveConfig.team,
          systemPrompt: effectiveConfig.systemPrompt,
          permissionMode: effectiveConfig.permissionMode,
          allowedTools: effectiveConfig.allowedTools,
          disallowedTools: effectiveConfig.disallowedTools,
          maxTurns: effectiveConfig.maxTurns,
          effort: effectiveConfig.effort,
        },
      });
      childSessionId = child.id;

      const bridgeTask = this.options.taskBridge.registerSessionTask({
        description: agentId,
        cwd: effectiveConfig.cwd,
        sessionId: effectiveConfig.parentSessionId,
        childSessionId: child.id,
        prompt: effectiveConfig.prompt,
        onInput: async (data) => {
          const generation = this.nextGeneration(taskId);
          try {
            const admitted = await this.options.host.admitPrompt(child.id, data);
            if (admitted.runId) {
              await this.options.taskBridge.bindSessionTaskRun?.(taskId, admitted.runId);
              this.monitorRun(taskId, child.id, admitted.runId, generation);
            }
          } catch (error) {
            if (this.taskGenerations.get(taskId) === generation) this.nextGeneration(taskId);
            const message = error instanceof Error ? error.message : String(error);
            try {
              await this.options.taskBridge.completeSessionTask(taskId, {
                status: "failed",
                output: message,
              });
            } finally {
              await this.options.host.closeRuntime(child.id).catch(() => {});
            }
            throw error;
          }
        },
        onStop: async () => {
          this.nextGeneration(taskId);
          await this.options.host.interrupt(child.id);
          await this.options.host.closeRuntime(child.id);
          await this.options.host.archive(child.id);
        },
      });
      taskId = bridgeTask.id;
      this.children.set(agentId, {
        sessionId: child.id,
        taskId,
        ...(worktreeSlug ? { worktreeSlug } : {}),
      });

      const generation = this.nextGeneration(taskId);
      const admitted = await this.options.host.admitPrompt(child.id, effectiveConfig.prompt);
      if (admitted.runId) {
        await this.options.taskBridge.bindSessionTaskRun?.(taskId, admitted.runId);
        this.monitorRun(taskId, child.id, admitted.runId, generation);
      }
      else await this.options.taskBridge.completeSessionTask(taskId, { status: "completed", output: "" });

      const result: SpawnResult = {
        success: true,
        agentId,
        taskId,
        sessionId: child.id,
        backendType: this.backendType,
        ...(worktree ? { worktree } : {}),
      };
      this.options.registerTeammate?.(effectiveConfig, result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.children.delete(agentId);
      if (taskId) this.nextGeneration(taskId);
      if (childSessionId) {
        await this.options.host.interrupt(childSessionId).catch(() => {});
        await this.options.host.closeRuntime(childSessionId).catch(() => {});
        await this.options.host.archive(childSessionId).catch(() => {});
      }
      if (taskId) {
        await this.options.taskBridge.completeSessionTask(taskId, {
          status: "failed",
          output: message,
        }).catch(() => {});
      }
      if (worktreeSlug && this.options.worktreeManager) {
        await this.options.worktreeManager.remove(worktreeSlug, { force: true }).catch(() => {});
      }
      return {
        success: false,
        agentId,
        taskId: "",
        backendType: this.backendType,
        error: message,
      };
    }
  }

  async sendMessage(agentId: string, message: TeammateMessage): Promise<void> {
    const child = this.children.get(agentId);
    if (!child) throw new Error(`No active child session for ${agentId}`);
    await this.options.taskBridge.writeToSessionTask(child.taskId, message.text);
  }

  async terminate(agentId: string): Promise<void> {
    const child = this.children.get(agentId);
    if (!child) throw new Error(`No active child session for ${agentId}`);
    this.nextGeneration(child.taskId);
    await this.options.host.interrupt(child.sessionId);
    await this.options.host.closeRuntime(child.sessionId);
    await this.options.host.archive(child.sessionId);
    await this.options.taskBridge.completeSessionTask(child.taskId, {
      status: "stopped",
      output: "Child session terminated",
    });
    if (child.worktreeSlug && this.options.worktreeManager) {
      const hasChanges = await this.options.worktreeManager.hasChanges(child.worktreeSlug).catch(() => true);
      if (!hasChanges) await this.options.worktreeManager.remove(child.worktreeSlug).catch(() => {});
    }
    this.children.delete(agentId);
    this.taskGenerations.delete(child.taskId);
  }

  private nextGeneration(taskId: string): number {
    const generation = (this.taskGenerations.get(taskId) ?? 0) + 1;
    this.taskGenerations.set(taskId, generation);
    return generation;
  }

  private monitorRun(taskId: string, sessionId: string, runId: string, generation: number): void {
    void this.options.host.awaitRun(sessionId, runId).then(
      async (result) => {
        if (this.taskGenerations.get(taskId) !== generation) return;
        try {
          await this.options.taskBridge.completeSessionTask(taskId, {
            status: result.status === "completed"
              ? "completed"
              : result.status === "interrupted"
              ? "interrupted"
              : "failed",
            output: result.output || result.error || "",
          });
        } finally {
          if (this.taskGenerations.get(taskId) === generation) {
            await this.options.host.closeRuntime(sessionId).catch(() => {});
          }
        }
      },
      async (error) => {
        if (this.taskGenerations.get(taskId) !== generation) return;
        try {
          await this.options.taskBridge.completeSessionTask(taskId, {
            status: "failed",
            output: error instanceof Error ? error.message : String(error),
          });
        } finally {
          if (this.taskGenerations.get(taskId) === generation) {
            await this.options.host.closeRuntime(sessionId).catch(() => {});
          }
        }
      },
    ).catch(() => {});
  }
}
