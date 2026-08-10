import { randomUUID } from "node:crypto";

import type {
  AgentChildAgentInput,
  AgentChildAgentResult,
  AgentRunScope,
} from "@openharness/core";
import type {
  AgentChildProjection,
  AgentChildProjectionHandle,
  AgentChildRunProjection,
} from "@openharness/agent-runtime";
import type { SessionStore } from "@openharness/services";

import type { ObservabilityEvent } from "../observability.js";
import type { StorePermissionBroker } from "../permission-broker.js";
import {
  buildChildAgentWorktreeSlug,
  createChildAgentWorktreeManager,
  type ChildAgentWorktreeManager,
} from "./child-agent-worktree.js";
import type { SessionTaskBridge } from "./session-task-bridge.js";
import type { LiveChildAgentRegistry } from "./live-child-agent-registry.js";
import { DaemonRunProjection } from "./session-run-projection.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";
import type { SessionTranscriptProjection } from "./transcript-projection.js";

interface DaemonChildState {
  taskId: string;
  taskBridge: SessionTaskBridge;
  parentScope: AgentRunScope;
  worktreeSlug?: string;
  worktreeManager?: ChildAgentWorktreeManager;
}

interface DaemonChildRunState {
  projection: DaemonRunProjection;
}

export interface DaemonChildAgentProjectionContext {
  store: SessionStore;
  createChildSession(input: {
    id?: string;
    parentId: string;
    cwd: string;
    model?: string;
    title: string;
    agent: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string }>;
  liveChildren: Pick<LiveChildAgentRegistry, "register" | "unregister">;
  createTaskBridge(session: { id: string; cwd: string }): SessionTaskBridge;
  permissionBroker: Pick<StorePermissionBroker, "ask">;
  transcriptProjection: SessionTranscriptProjection;
  events: Pick<SessionEventPublisher, "checkpoint" | "publish" | "publishSince">;
  traceIdForRun(runId: string): string;
  log(event: ObservabilityEvent): void;
  createWorktreeManager?: (cwd: string) => Promise<ChildAgentWorktreeManager>;
}

/** Projects framework-owned child execution into daemon sessions, runs and tasks. */
export class DaemonChildAgentProjection implements AgentChildProjection {
  constructor(private readonly context: DaemonChildAgentProjectionContext) {}

  async createChild(input: Parameters<AgentChildProjection["createChild"]>[0]): Promise<AgentChildProjectionHandle> {
    const team = input.spawn.team ?? "default";
    let cwd = input.spawn.cwd;
    let worktree: AgentChildProjectionHandle["worktree"];
    let worktreeSlug: string | undefined;
    let worktreeManager: ChildAgentWorktreeManager | undefined;

    if (input.spawn.isolate) {
      worktreeManager = await this.createWorktreeManager(input.spawn.cwd);
      if (await worktreeManager.isGitRepo()) {
        const slug = buildChildAgentWorktreeSlug({ team, agent: input.spawn.agent });
        const created = await worktreeManager.create(slug);
        cwd = created.path;
        worktree = { path: created.path, branch: created.branch };
        if (created.created) worktreeSlug = created.slug;
      }
    }

    let childId: string | undefined;
    let taskId: string | undefined;
    let taskBridge: SessionTaskBridge | undefined;
    let registered = false;
    try {
      const child = await this.context.createChildSession({
        ...(input.spawn.sessionId ? { id: input.spawn.sessionId } : {}),
        parentId: input.parentScope.sessionId,
        cwd,
        ...(input.spawn.model ? { model: input.spawn.model } : {}),
        title: `${input.spawn.agent}@${team}`,
        agent: input.spawn.agent,
        metadata: {
          ...input.spawn.metadata,
          team,
          systemPrompt: input.spawn.systemPrompt,
          permissionMode: input.spawn.permissionMode,
          allowedTools: input.spawn.allowedTools,
          disallowedTools: input.spawn.disallowedTools,
          maxTurns: input.spawn.maxTurns,
          effort: input.spawn.effort,
          isolate: input.spawn.isolate,
          ...(worktree ? { worktree } : {}),
        },
      });
      childId = child.id;
      taskBridge = this.context.createTaskBridge({
        id: input.parentScope.sessionId,
        cwd: input.parentScope.cwd,
      });
      const task = taskBridge.registerSessionTask({
        description: input.spawn.description,
        cwd,
        sessionId: input.parentScope.sessionId,
        childSessionId: child.id,
        prompt: input.spawn.prompt,
        onInput: async (content) => {
          await input.controls.send({ content });
        },
        onStop: () => input.controls.interrupt("Child agent stopped"),
      });
      taskId = task.id;
      this.context.liveChildren.register(child.id, input.invocationId, input.controls);
      registered = true;
      return {
        invocationId: input.invocationId,
        sessionId: child.id,
        cwd,
        taskId: task.id,
        ...(worktree ? { worktree } : {}),
        state: {
          taskId: task.id,
          taskBridge,
          parentScope: input.parentScope,
          ...(worktreeSlug ? { worktreeSlug } : {}),
          ...(worktreeManager ? { worktreeManager } : {}),
        } satisfies DaemonChildState,
      };
    } catch (error) {
      if (registered && childId) {
        this.context.liveChildren.unregister(childId, input.invocationId);
      }
      if (taskId && taskBridge) {
        const message = error instanceof Error ? error.message : String(error);
        await taskBridge.completeSessionTask(taskId, {
          status: "failed",
          output: message,
        }).catch(() => {});
      }
      if (childId) {
        const before = this.context.events.checkpoint();
        this.context.store.archiveSession(childId);
        this.context.events.publishSince(before);
      }
      if (worktreeSlug && worktreeManager) {
        await worktreeManager.remove(worktreeSlug).catch(() => {});
      }
      throw error;
    }
  }

  async startRun(
    child: AgentChildProjectionHandle,
    input: AgentChildAgentInput,
    signal: AbortSignal,
  ): Promise<AgentChildRunProjection> {
    const state = child.state as DaemonChildState;
    const traceId = input.traceId ?? randomUUID();
    const before = this.context.events.checkpoint();
    const admitted = this.context.store.admitPrompt({
      id: input.id,
      sessionId: child.sessionId,
      delivery: input.delivery ?? "queue",
      content: input.content,
      metadata: { ...input.metadata, traceId, parentRunId: state.parentScope.runId },
    });
    const run = this.context.store.createRun({
      sessionId: child.sessionId,
      inputId: admitted.id,
      metadata: { traceId, parentRunId: state.parentScope.runId },
    });
    this.context.events.publishSince(before);

    try {
      await state.taskBridge.bindSessionTaskRun(state.taskId, run.id);
    } catch (error) {
      const failedAt = this.context.events.checkpoint();
      this.context.store.updateRun(run.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      this.context.events.publishSince(failedAt);
      throw error;
    }
    const projection = new DaemonRunProjection({
      store: this.context.store,
      permissionBroker: this.context.permissionBroker,
      transcriptProjection: this.context.transcriptProjection,
      events: this.context.events,
      sessionId: child.sessionId,
      inputId: admitted.id,
      runId: run.id,
      traceId,
      signal,
      log: this.context.log,
    });
    projection.start(input.content);
    const scope: AgentRunScope = {
      sessionId: child.sessionId,
      inputId: admitted.id,
      runId: run.id,
      cwd: child.cwd,
      traceId,
      signal,
    };
    return {
      inputId: admitted.id,
      runId: run.id,
      host: projection.createHost(scope),
      state: { projection } satisfies DaemonChildRunState,
    };
  }

  async finishRun(
    child: AgentChildProjectionHandle,
    run: AgentChildRunProjection,
    result: AgentChildAgentResult,
  ): Promise<void> {
    const projection = (run.state as DaemonChildRunState).projection;
    if (result.status === "completed") projection.complete(false);
    else if (result.status === "interrupted" || result.status === "stopped") projection.complete(true);
    else projection.fail(new Error(result.error ?? result.output), false);
    const state = child.state as DaemonChildState;
    await state.taskBridge.completeSessionTask(state.taskId, result);
  }

  async failRunStart(child: AgentChildProjectionHandle, result: AgentChildAgentResult): Promise<void> {
    const state = child.state as DaemonChildState;
    await state.taskBridge.completeSessionTask(state.taskId, result);
  }

  async closeChild(child: AgentChildProjectionHandle, result: AgentChildAgentResult): Promise<void> {
    const state = child.state as DaemonChildState;
    this.context.liveChildren.unregister(child.sessionId, child.invocationId);
    const task = this.context.store.getSessionTask(state.taskId);
    if (task && (task.status === "pending" || task.status === "running")) {
      await state.taskBridge.completeSessionTask(state.taskId, result).catch(() => {});
    }
    if (state.worktreeSlug && state.worktreeManager) {
      const hasChanges = await state.worktreeManager.hasChanges(state.worktreeSlug).catch(() => true);
      if (!hasChanges) await state.worktreeManager.remove(state.worktreeSlug).catch(() => {});
    }
  }

  private async createWorktreeManager(cwd: string): Promise<ChildAgentWorktreeManager> {
    return this.context.createWorktreeManager
      ? await this.context.createWorktreeManager(cwd)
      : createChildAgentWorktreeManager({ cwd });
  }
}
