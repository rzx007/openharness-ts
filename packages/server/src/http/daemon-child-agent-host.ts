import { randomUUID } from "node:crypto";

import type {
  ChildAgentInput,
  ChildAgentInvocation,
  ChildAgentResult,
  ChildAgentSpawnInput,
  RuntimeChildAgentHost,
  RuntimeHostScope,
} from "../runtime-host.js";
import type { ChildSessionHost, SessionTaskBridge } from "./child-agent-ports.js";
import {
  buildChildAgentWorktreeSlug,
  createChildAgentWorktreeManager,
  type ChildAgentWorktreeManager,
} from "./child-agent-worktree.js";

interface ChildInvocationRecord {
  taskId: string;
  sessionId: string;
  runId?: string;
  generation: number;
  result: Promise<ChildAgentResult>;
  worktreeSlug?: string;
  worktreeManager?: ChildAgentWorktreeManager;
}

export interface DaemonChildAgentHostContext {
  scope: RuntimeHostScope;
  childSessionHost: ChildSessionHost;
  sessionTaskBridge: SessionTaskBridge;
  createWorktreeManager?: (cwd: string) => Promise<ChildAgentWorktreeManager>;
}

export class DaemonChildAgentHost implements RuntimeChildAgentHost {
  private readonly invocations = new Map<string, ChildInvocationRecord>();

  constructor(private readonly context: DaemonChildAgentHostContext) {}

  async spawnChildAgent(input: ChildAgentSpawnInput): Promise<ChildAgentInvocation> {
    const invocationId = `child_${randomUUID()}`;
    const team = input.team ?? "default";
    let effectiveCwd = input.cwd;
    let worktree: ChildAgentInvocation["worktree"];
    let worktreeSlug: string | undefined;
    let worktreeManager: ChildAgentWorktreeManager | undefined;
    let childSessionId: string | undefined;
    let taskId: string | undefined;

    try {
      if (input.isolate) {
        worktreeManager = await this.createWorktreeManager(input.cwd);
        if (await worktreeManager.isGitRepo()) {
          const slug = buildChildAgentWorktreeSlug({ team, agent: input.agent });
          const created = await worktreeManager.create(slug);
          effectiveCwd = created.path;
          worktree = { path: created.path, branch: created.branch };
          if (created.created) worktreeSlug = created.slug;
        }
      }

      const child = await this.context.childSessionHost.createChildSession({
        ...(input.sessionId ? { id: input.sessionId } : {}),
        parentId: this.context.scope.sessionId,
        cwd: effectiveCwd,
        ...(input.model ? { model: input.model } : {}),
        title: `${input.agent}@${team}`,
        agent: input.agent,
        metadata: {
          ...input.metadata,
          team,
          systemPrompt: input.systemPrompt,
          permissionMode: input.permissionMode,
          allowedTools: input.allowedTools,
          disallowedTools: input.disallowedTools,
          maxTurns: input.maxTurns,
          effort: input.effort,
          isolate: input.isolate,
          ...(worktree ? { worktree } : {}),
        },
      });
      childSessionId = child.id;

      const task = this.context.sessionTaskBridge.registerSessionTask({
        description: input.description,
        cwd: effectiveCwd,
        sessionId: this.context.scope.sessionId,
        childSessionId: child.id,
        prompt: input.prompt,
        onInput: async (data) => {
          await this.sendToChild(invocationId, data);
        },
        onStop: async () => {
          await this.interruptChildAgent(invocationId, "Child agent stopped");
        },
      });
      taskId = task.id;

      const admitted = await this.context.childSessionHost.admitPrompt(child.id, input.prompt);
      if (admitted.runId) await this.context.sessionTaskBridge.bindSessionTaskRun(task.id, admitted.runId);
      const record: ChildInvocationRecord = {
        taskId: task.id,
        sessionId: child.id,
        ...(admitted.runId ? { runId: admitted.runId } : {}),
        generation: 0,
        result: Promise.resolve({ status: "completed", output: "" }),
        ...(worktreeSlug ? { worktreeSlug } : {}),
        ...(worktreeManager ? { worktreeManager } : {}),
      };
      this.invocations.set(invocationId, record);
      const result = this.monitorRun(record, admitted.runId);
      record.result = result;

      return {
        id: invocationId,
        taskId: task.id,
        sessionId: child.id,
        ...(admitted.runId ? { runId: admitted.runId } : {}),
        result,
        ...(worktree ? { worktree } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (taskId) {
        await this.context.sessionTaskBridge.completeSessionTask(taskId, { status: "failed", output: message }).catch(() => {});
      }
      if (childSessionId) {
        await this.context.childSessionHost.interrupt(childSessionId).catch(() => {});
        await this.context.childSessionHost.closeRuntime(childSessionId).catch(() => {});
        await this.context.childSessionHost.archive(childSessionId).catch(() => {});
      }
      if (worktreeSlug && worktreeManager) {
        await worktreeManager.remove(worktreeSlug, { force: true }).catch(() => {});
      }
      throw error;
    }
  }

  async sendChildInput(invocationId: string, input: ChildAgentInput): Promise<void> {
    const record = this.getInvocation(invocationId);
    await this.context.sessionTaskBridge.writeToSessionTask(record.taskId, input.content);
  }

  async interruptChildAgent(invocationId: string, _reason?: string): Promise<void> {
    const record = this.getInvocation(invocationId);
    record.generation++;
    await this.context.childSessionHost.interrupt(record.sessionId);
    await this.context.childSessionHost.closeRuntime(record.sessionId);
    await this.context.childSessionHost.archive(record.sessionId);
    await this.context.sessionTaskBridge.completeSessionTask(record.taskId, {
      status: "stopped",
      output: "Child agent stopped",
    });
    if (record.worktreeSlug && record.worktreeManager) {
      const hasChanges = await record.worktreeManager.hasChanges(record.worktreeSlug).catch(() => true);
      if (!hasChanges) await record.worktreeManager.remove(record.worktreeSlug).catch(() => {});
    }
    this.invocations.delete(invocationId);
  }

  async awaitChildAgent(invocationId: string): Promise<ChildAgentResult> {
    return await this.getInvocation(invocationId).result;
  }

  private async sendToChild(invocationId: string, content: string): Promise<void> {
    const record = this.getInvocation(invocationId);
    const admitted = await this.context.childSessionHost.admitPrompt(record.sessionId, content);
    if (admitted.runId) {
      record.runId = admitted.runId;
      await this.context.sessionTaskBridge.bindSessionTaskRun(record.taskId, admitted.runId);
      const result = this.monitorRun(record, admitted.runId);
      record.result = result;
    }
  }

  private monitorRun(record: ChildInvocationRecord, runId: string | undefined): Promise<ChildAgentResult> {
    const generation = ++record.generation;
    if (!runId) {
      const result: ChildAgentResult = { status: "completed", output: "" };
      void this.context.sessionTaskBridge.completeSessionTask(record.taskId, result);
      return Promise.resolve(result);
    }

    return this.context.childSessionHost.awaitRun(record.sessionId, runId).then(
      async (result) => {
        if (record.generation !== generation) return result;
        const normalized: ChildAgentResult = {
          status: result.status,
          output: result.output,
          ...(result.error ? { error: result.error } : {}),
        };
        await this.context.sessionTaskBridge.completeSessionTask(record.taskId, normalized);
        await this.context.childSessionHost.closeRuntime(record.sessionId).catch(() => {});
        return normalized;
      },
      async (error) => {
        if (record.generation !== generation) return { status: "failed", output: "", error: "" };
        const message = error instanceof Error ? error.message : String(error);
        const result: ChildAgentResult = { status: "failed", output: message, error: message };
        await this.context.sessionTaskBridge.completeSessionTask(record.taskId, result).catch(() => {});
        await this.context.childSessionHost.closeRuntime(record.sessionId).catch(() => {});
        return result;
      },
    );
  }

  private getInvocation(invocationId: string): ChildInvocationRecord {
    const record = this.invocations.get(invocationId);
    if (!record) throw new Error(`Child agent invocation not found: ${invocationId}`);
    return record;
  }

  private async createWorktreeManager(cwd: string): Promise<ChildAgentWorktreeManager> {
    if (this.context.createWorktreeManager) return await this.context.createWorktreeManager(cwd);
    return createChildAgentWorktreeManager({ cwd });
  }
}
