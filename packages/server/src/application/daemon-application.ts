import { randomUUID } from "node:crypto";

import type { Settings } from "@openharness/core";
import {
  buildChildAgentWorktreeSlug,
  createChildAgentWorktreeManager,
} from "@openharness/agent-runtime";
import type { AgentTerminalHost } from "@openharness/terminal";
import type { AgentJobHost } from "@openharness/jobs";
import type { SessionRecord } from "@openharness/services";
import { getTaskManager, type SessionStore } from "@openharness/services";

import {
  createDaemonAgentLoader,
  type CreateDaemonAgent,
} from "../daemon/daemon-agent.js";
import { ScheduledTaskService } from "../daemon/scheduled-task-service.js";
import type { ObservabilityEvent } from "../shared/observability.js";
import { StorePermissionBroker } from "../permissions/permission-broker.js";
import {
  DAEMON_RESTART_PERMISSION_REASON,
  DAEMON_RESTART_RUN_REASON,
  DAEMON_RESTART_TASK_REASON,
  normalizeTraceId,
} from "../http/support.js";
import { AgentPool } from "../http/agent/agent-pool.js";
import { DaemonAgentEventProjector } from "../http/agent/daemon-agent-event-projector.js";
import { DaemonControlService } from "../http/control/daemon-control-service.js";
import { DaemonOperationGate } from "../http/control/daemon-operation-gate.js";
import { LiveChildAgentDirectory } from "../http/agent/live-child-agent-directory.js";
import { SessionApplicationService } from "../http/session/session-application-service.js";
import {
  SessionEventPublisher,
  type SessionEventSink,
} from "../http/session/session-event-publisher.js";
import { SessionMaintenanceService } from "../http/session/session-maintenance-service.js";
import { SessionQueryService } from "../http/session/session-query-service.js";
import { SessionRunEngine } from "../http/session/session-run-engine.js";
import { SessionRunExecutor } from "../http/session/session-run-executor.js";
import { SessionTaskBridgeManager } from "../http/session/session-task-bridge.js";
import { SessionTaskService } from "../http/session/session-task-service.js";
import { SessionTranscriptProjection } from "../http/session/transcript-projection.js";
import { recoverInterruptedWorkflows } from "../http/session/workflow-recovery.js";

export interface DaemonApplicationOptions {
  store: SessionStore;
  eventSink: SessionEventSink;
  settings?: Settings;
  getSettings?: () => Settings;
  getSettingsForCwd?: (cwd: string) => Promise<Settings>;
  createAgent?: CreateDaemonAgent;
  createTerminalHost?(session: SessionRecord): AgentTerminalHost;
  createJobHost?(session: SessionRecord): AgentJobHost;
  sseClientCount(): number;
  log(event: ObservabilityEvent): void;
}

/** Daemon-owned durable application graph, independent from HTTP routing and listening. */
export class DaemonApplication {
  readonly permissions: StorePermissionBroker;
  readonly tasks: SessionTaskService;
  readonly sessions: SessionApplicationService;
  readonly maintenance: SessionMaintenanceService;
  readonly queries: SessionQueryService;
  readonly control: DaemonControlService;
  readonly schedules: ScheduledTaskService;

  private readonly events: SessionEventPublisher;
  private readonly transcriptProjection: SessionTranscriptProjection;
  private readonly taskBridges: SessionTaskBridgeManager;
  private readonly liveChildren = new LiveChildAgentDirectory();
  private readonly operationGate = new DaemonOperationGate();
  private readonly agentPool: AgentPool;
  private readonly runEngine: SessionRunEngine;
  private readonly startupRecovery: Promise<void>;

  constructor(private readonly options: DaemonApplicationOptions) {
    const { store } = options;
    store.interruptActiveRuns(DAEMON_RESTART_RUN_REASON);
    store.interruptActiveSessionTasks(DAEMON_RESTART_TASK_REASON);
    store.expirePendingPermissionRequests(DAEMON_RESTART_PERMISSION_REASON);
    store.finalizeClosingSessions();

    this.events = new SessionEventPublisher(store, options.eventSink);
    this.permissions = new StorePermissionBroker({
      store,
      onChange: (previousEventSeq) =>
        this.events.publishSince(previousEventSeq),
      logger: options.log,
    });
    this.transcriptProjection = new SessionTranscriptProjection(store);
    this.taskBridges = new SessionTaskBridgeManager({
      store,
      getTaskManager: (scope) => getTaskManager(scope),
      events: this.events,
      traceIdForRun: (runId) => this.traceIdForRun(runId),
      log: options.log,
    });
    this.tasks = new SessionTaskService({
      store,
      bridgeManager: this.taskBridges,
      getTaskManager: (scope) => getTaskManager(scope),
      events: this.events,
    });

    const loadAgent = createDaemonAgentLoader({
      settings: options.settings,
      getSettings: options.getSettings,
      getSettingsForCwd: options.getSettingsForCwd,
      createAgent: options.createAgent,
      createTerminalHost: options.createTerminalHost,
      createJobHost: options.createJobHost,
      requestPermission: async (request, context) => {
        return await this.permissions.ask({
          sessionId: context.sessionId,
          runId: context.runId,
          traceId: context.traceId,
          toolName: request.toolName,
          reason: request.reason,
          input: request.input,
          signal: context.signal,
        });
      },
      schedules: {
        create: async (input) =>
          this.schedules.createTask({ ...input, createdBy: "agent" }),
        update: async (id, patch) => this.schedules.updateTask(id, patch),
        remove: async (id) => this.schedules.removeTask(id),
        list: async () => this.schedules.listTasks(),
        trigger: async (id) => this.schedules.trigger(id),
        listRuns: async (taskId) => this.schedules.listRuns({ taskId }),
      },
      createEventSink: (agent) => {
        const projector = new DaemonAgentEventProjector({
          rootAgent: agent,
          store,
          transcriptProjection: this.transcriptProjection,
          taskBridgeManager: this.taskBridges,
          liveChildren: this.liveChildren,
          events: this.events,
          log: options.log,
        });
        return (event) => projector.apply(event);
      },
    });
    this.agentPool = new AgentPool({
      store,
      loadAgent,
      isSessionExternallyOwned: (sessionId) => this.liveChildren.has(sessionId),
    });

    const runExecutor = new SessionRunExecutor({
      store,
      agentPool: this.agentPool,
      events: this.events,
      transcriptProjection: this.transcriptProjection,
      traceIdForRun: (runId) => this.traceIdForRun(runId),
      log: options.log,
    });
    this.runEngine = new SessionRunEngine({
      store,
      agentPool: this.agentPool,
      runExecutor,
      events: this.events,
    });
    this.control = new DaemonControlService({
      store,
      runEngine: this.runEngine,
      agentPool: this.agentPool,
      operationGate: this.operationGate,
      startedAt: Date.now(),
      sseClientCount: options.sseClientCount,
    });
    this.maintenance = new SessionMaintenanceService({
      store,
      runEngine: this.runEngine,
      agentPool: this.agentPool,
      liveChildren: this.liveChildren,
      operationGate: this.operationGate,
      events: this.events,
    });
    this.sessions = new SessionApplicationService({
      store,
      runEngine: this.runEngine,
      agentPool: this.agentPool,
      liveChildren: this.liveChildren,
      operationGate: this.operationGate,
      events: this.events,
    });
    this.schedules = new ScheduledTaskService({
      store,
      execute: async (task, scheduledRun) => {
        const projectCwd = task.projectPaths[0];
        let executionCwd = projectCwd;
        let worktree:
          | {
              manager: ReturnType<typeof createChildAgentWorktreeManager>;
              slug: string;
              path: string;
              branch: string;
              created: boolean;
            }
          | undefined;
        if (task.executionMode === "worktree") {
          if (!projectCwd)
            throw new Error(
              "Worktree scheduled execution requires user attention: project is unavailable",
            );
          const manager = createChildAgentWorktreeManager({ cwd: projectCwd });
          if (!(await manager.isGitRepo())) {
            throw new Error(
              "Worktree scheduled execution requires user attention: project is not a Git repository",
            );
          }
          const slug = buildChildAgentWorktreeSlug({
            team: "scheduled",
            agent: task.id,
            nonce: scheduledRun.id.slice(0, 8),
          });
          const created = await manager.create(slug).catch((error) => {
            const message =
              error instanceof Error ? error.message : String(error);
            throw new Error(
              `Worktree scheduled execution requires user attention: ${message}`,
            );
          });
          worktree = { manager, ...created };
          executionCwd = created.path;
        }
        let session = task.sessionId
          ? this.sessions.getSession(task.sessionId)
          : undefined;
        try {
          if (task.destination === "chat") {
            if (!session)
              throw new Error(
                `Scheduled task chat is unavailable: ${task.sessionId}`,
              );
            if (session.status === "archived") {
              throw new Error(
                "Scheduled task chat is archived and requires user attention",
              );
            }
          } else {
            if (!executionCwd)
              throw new Error("Scheduled task project is unavailable");
            const settingsCwd = projectCwd ?? executionCwd;
            const settings =
              (await options.getSettingsForCwd?.(settingsCwd)) ??
              options.getSettings?.() ??
              options.settings;
            const model = task.model ?? settings?.model;
            if (!model) throw new Error("Scheduled task model is unavailable");
            const permissionMode = scheduledPermissionMode(
              task.permissionProfile.mode,
            );
            const deniedTools = new Set(
              task.permissionProfile.deniedTools ?? [],
            );
            if (task.permissionProfile.network === false) {
              deniedTools.add("WebFetch");
              deniedTools.add("WebSearch");
            }
            session = this.sessions.createSession({
              cwd: executionCwd,
              title: `${task.name} · scheduled run`,
              model,
              metadata: {
                runtime: {
                  model,
                  permissionMode,
                  ...(isScheduledEffort(task.effort)
                    ? { effort: task.effort }
                    : {}),
                  ...(task.permissionProfile.allowedTools?.length
                    ? { allowedTools: task.permissionProfile.allowedTools }
                    : {}),
                  ...(deniedTools.size > 0
                    ? { disallowedTools: [...deniedTools] }
                    : {}),
                },
                scheduledTask: {
                  taskId: task.id,
                  scheduledRunId: scheduledRun.id,
                  destination: task.destination,
                  executionMode: task.executionMode,
                  ...(worktree
                    ? {
                        worktree: {
                          path: worktree.path,
                          branch: worktree.branch,
                        },
                      }
                    : {}),
                },
              },
            });
          }
          const admission = await this.sessions.admitPrompt(session!.id, {
            id: `scheduled-input:${scheduledRun.id}`,
            content: scheduledPrompt(task),
            delivery: "queue",
            metadata: {
              source: "scheduled_task",
              scheduledTaskId: task.id,
              scheduledRunId: scheduledRun.id,
              scheduledFor: scheduledRun.scheduledFor,
            },
            runMetadata: {
              source: "scheduled_task",
              scheduledTaskId: task.id,
              scheduledRunId: scheduledRun.id,
            },
          });
          if (!admission.run)
            throw new Error("Scheduled task Agent runtime is unavailable");
          const result = await this.sessions.awaitRun(
            session!.id,
            admission.run.id,
          );
          if (result.status !== "completed") {
            throw new Error(
              result.error ?? `Scheduled Agent run ${result.status}`,
            );
          }
          return {
            sessionId: session!.id,
            runId: admission.run.id,
            summary: result.output.slice(0, 20_000),
          };
        } finally {
          if (worktree?.created) {
            const hasChanges = await worktree.manager
              .hasChanges(worktree.slug)
              .catch(() => true);
            if (!hasChanges) {
              await worktree.manager.remove(worktree.slug).catch(() => {});
            }
          }
        }
      },
    });
    this.queries = new SessionQueryService(store);
    this.startupRecovery = recoverInterruptedWorkflows({
      store,
      events: this.events,
    });
    void this.startupRecovery.catch(() => {});
  }

  async ready(): Promise<void> {
    await this.startupRecovery;
  }

  async shutdown(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.startupRecovery;
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.schedules.shutdown();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.control.shutdown();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Daemon application shutdown failed");
  }

  private traceIdForRun(runId: string): string {
    const run = this.options.store.getRun(runId);
    const traceId = normalizeTraceId(run?.metadata.traceId);
    if (traceId) return traceId;
    const generated = randomUUID();
    if (run)
      this.options.store.updateRun(runId, { metadata: { traceId: generated } });
    return generated;
  }
}

function scheduledPermissionMode(
  mode: "read_only" | "workspace_write" | "full_access",
): "plan" | "default" | "full_auto" {
  if (mode === "read_only") return "plan";
  if (mode === "full_access") return "full_auto";
  return "default";
}

function isScheduledEffort(
  value: string | undefined,
): value is "low" | "medium" | "high" {
  return value === "low" || value === "medium" || value === "high";
}

function scheduledPrompt(task: {
  prompt: string;
  skillNames: string[];
  pluginNames: string[];
}): string {
  const context: string[] = [];
  if (task.skillNames.length > 0) {
    context.push(
      `Use these task skills when applicable: ${task.skillNames.join(", ")}.`,
    );
  }
  if (task.pluginNames.length > 0) {
    context.push(
      `Use these connected plugins when applicable: ${task.pluginNames.join(", ")}.`,
    );
  }
  return context.length > 0
    ? `${task.prompt}\n\n${context.join("\n")}`
    : task.prompt;
}
