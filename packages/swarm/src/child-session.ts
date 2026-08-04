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
  // 维护 agentId -> child session 的映射，便于后续 sendMessage / terminate 直接定位子会话。
  private readonly children = new Map<string, { sessionId: string; taskId: string; worktreeSlug?: string }>();
  // 记录每个会话任务的生成编号，用于丢弃已过期的异步 run 结果，避免旧事件覆盖新状态。
  private readonly taskGenerations = new Map<string, number>();

  constructor(private options: ChildSessionBackendOptions) {}

  reconfigure(options: ChildSessionBackendOptions): void {
    this.options = options;
  }

  async spawn(config: TeammateSpawnConfig): Promise<SpawnResult> {
    // agentId 是全局唯一标识，便于在 children Map 中做查找与归属管理。
    const agentId = `${config.name}@${config.team}`;
    let effectiveConfig = config;
    let worktree: SpawnResult["worktree"];
    let worktreeSlug: string | undefined;
    let childSessionId: string | undefined;
    let taskId = "";
    try {
      // 仅在开启 isolate 且当前仓库可用时，才创建独立 git worktree；这样并行写任务不会互相污染同一工作目录。
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

      // 创建真正的子会话，并把 metadata 透传给 host，便于运行时识别团队、权限模式、工具约束等信息。
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

      // 注册会话任务桥：后续输入、停止信号都由 taskBridge 来驱动与落盘。
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
      // 记录活跃子会话的映射，方便后续消息发送与 terminate。
      this.children.set(agentId, {
        sessionId: child.id,
        taskId,
        ...(worktreeSlug ? { worktreeSlug } : {}),
      });

      // 首次提交 prompt，并异步监听 run 完成状态，最后用 taskBridge 完成任务记录。
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
