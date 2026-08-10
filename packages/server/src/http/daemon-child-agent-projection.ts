import { randomUUID } from "node:crypto";

import type {
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
  worktreeSlug?: string;
  worktreeManager?: ChildAgentWorktreeManager;
}

interface DaemonChildRunState {
  projection: DaemonRunProjection;
}

export interface DaemonChildAgentProjectionContext {
  parentScope: AgentRunScope;
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
  taskBridge: SessionTaskBridge;
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
    const task = this.context.taskBridge.registerSessionTask({
      description: input.spawn.description,
      cwd,
      sessionId: input.parentScope.sessionId,
      childSessionId: child.id,
      prompt: input.spawn.prompt,
      onInput: (content) => input.controls.send({ content }),
      onStop: () => input.controls.interrupt("Child agent stopped"),
    });
    this.context.liveChildren.register(child.id, input.invocationId, input.controls);
    return {
      invocationId: input.invocationId,
      sessionId: child.id,
      cwd,
      taskId: task.id,
      ...(worktree ? { worktree } : {}),
      state: {
        taskId: task.id,
        ...(worktreeSlug ? { worktreeSlug } : {}),
        ...(worktreeManager ? { worktreeManager } : {}),
      } satisfies DaemonChildState,
    };
  }

  async startRun(
    child: AgentChildProjectionHandle,
    content: string,
    signal: AbortSignal,
  ): Promise<AgentChildRunProjection> {
    const traceId = randomUUID();
    const before = this.context.events.checkpoint();
    const admitted = this.context.store.admitPrompt({
      sessionId: child.sessionId,
      delivery: "queue",
      content,
      metadata: { traceId, parentRunId: this.context.parentScope.runId },
    });
    const run = this.context.store.createRun({
      sessionId: child.sessionId,
      inputId: admitted.id,
      metadata: { traceId, parentRunId: this.context.parentScope.runId },
    });
    this.context.events.publishSince(before);

    const state = child.state as DaemonChildState;
    await this.context.taskBridge.bindSessionTaskRun(state.taskId, run.id);
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
    projection.start(content);
    const scope: AgentRunScope = {
      sessionId: child.sessionId,
      inputId: admitted.id,
      runId: run.id,
      cwd: child.cwd,
      traceId,
      signal,
    };
    return {
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
    await this.context.taskBridge.completeSessionTask(state.taskId, result);
  }

  async closeChild(child: AgentChildProjectionHandle, result: AgentChildAgentResult): Promise<void> {
    const state = child.state as DaemonChildState;
    this.context.liveChildren.unregister(child.sessionId, child.invocationId);
    await this.context.taskBridge.completeSessionTask(state.taskId, result).catch(() => {});
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
