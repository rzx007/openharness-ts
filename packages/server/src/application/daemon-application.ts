import { randomUUID } from "node:crypto";

import type { Settings } from "@openharness/core";
import {
  buildChildAgentWorktreeSlug,
  createChildAgentWorktreeManager,
} from "@openharness/agent-runtime";
import type { AgentTerminalHost } from "@openharness/terminal";
import type { AgentJobHost } from "@openharness/jobs";
import type { SessionRecord } from "@openharness/services";
import {
  closeExecutionRuntimes,
  getChildAgentExecutionRegistry,
  getDetachedProcessSupervisor,
  type SessionStore,
  type ApplicationOwnerLease,
} from "@openharness/services";

import {
  createDaemonAgentLoader,
  type CreateDaemonAgent,
} from "../daemon/daemon-agent.js";
import { ScheduledTaskService } from "../daemon/scheduled-task-service.js";
import { DaemonJobService } from "../jobs/daemon-job-service.js";
import type { ObservabilityEvent } from "../shared/observability.js";
import { DaemonTerminalService } from "../terminal/daemon-terminal-service.js";
import { StorePermissionBroker } from "../permissions/permission-broker.js";
import {
  DAEMON_RESTART_PERMISSION_REASON,
  DAEMON_RESTART_INPUT_REASON,
  DAEMON_RESTART_RUN_REASON,
  DAEMON_RESTART_TASK_REASON,
  normalizeTraceId,
} from "./support.js";
import { AgentPool } from "./agent/agent-pool.js";
import { DaemonAgentEventProjector } from "./agent/daemon-agent-event-projector.js";
import {
  DAEMON_AGENT_PROJECTOR,
  recoverProjectionSettlements,
} from "./agent/projection-settlement-recovery.js";
import { DaemonControlService } from "./control/daemon-control-service.js";
import { DaemonOperationGate } from "./control/daemon-operation-gate.js";
import { LiveChildAgentDirectory } from "./agent/live-child-agent-directory.js";
import { SessionApplicationService } from "./session/session-application-service.js";
import {
  SessionEventPublisher,
} from "./session/session-event-publisher.js";
import { SessionMaintenanceService } from "./session/session-maintenance-service.js";
import { SessionQueryService } from "./session/session-query-service.js";
import { SessionRunEngine } from "./session/session-run-engine.js";
import { SessionRunExecutor } from "./session/session-run-executor.js";
import { SessionExecutionProjector } from "./session/session-execution-projector.js";
import { BackgroundShellService } from "./session/background-shell-service.js";
import { SessionTranscriptProjection } from "./session/transcript-projection.js";
import { recoverInterruptedWorkflows } from "./session/workflow-recovery.js";
import { ApplicationEventService } from "./events/application-event-service.js";
import { ProjectApplicationService } from "./project-application-service.js";
import { ChannelApplicationService } from "./channel/channel-application-service.js";
import { SessionWorkflowRunRepository } from "./workflow/session-workflow-run-repository.js";
import { ApplicationRetentionService } from "./retention/application-retention-service.js";

export interface DaemonApplicationOptions {
  store: SessionStore;
  /** 只有默认 Node 组装应设为 true；外部注入的 Store 默认由调用方关闭。 */
  ownsStore?: boolean;
  settings?: Settings;
  getSettings?: () => Settings;
  getSettingsForCwd?: (cwd: string) => Promise<Settings>;
  createAgent?: CreateDaemonAgent;
  createTerminalHost?(session: SessionRecord): AgentTerminalHost;
  createJobHost?(session: SessionRecord): AgentJobHost;
  log(event: ObservabilityEvent): void;
  ownerId?: string;
  ownerHeartbeatMs?: number;
  ownerStaleAfterMs?: number;
}

export interface DurableAgentApplication {
  readonly store: SessionStore;
  readonly sessions: SessionApplicationService;
  readonly queries: SessionQueryService;
  readonly permissions: StorePermissionBroker;
  readonly backgroundShells: BackgroundShellService;
  readonly maintenance: SessionMaintenanceService;
  readonly control: DaemonControlService;
  readonly schedules: ScheduledTaskService;
  readonly jobs: DaemonJobService;
  readonly terminals: DaemonTerminalService;
  readonly projects: ProjectApplicationService;
  readonly events: ApplicationEventService;
  readonly channels: ChannelApplicationService;
  readonly workflows: SessionWorkflowRunRepository;
  readonly retention: ApplicationRetentionService;
  ready(): Promise<void>;
  close(): Promise<void>;
}

/** Daemon-owned durable application graph, independent from HTTP routing and listening. */
export class DaemonApplication implements DurableAgentApplication {
  readonly store: SessionStore;
  readonly permissions: StorePermissionBroker;
  readonly backgroundShells: BackgroundShellService;
  readonly sessions: SessionApplicationService;
  readonly maintenance: SessionMaintenanceService;
  readonly queries: SessionQueryService;
  readonly control: DaemonControlService;
  readonly schedules: ScheduledTaskService;
  readonly jobs: DaemonJobService;
  readonly terminals: DaemonTerminalService;
  readonly projects: ProjectApplicationService;
  readonly events: ApplicationEventService;
  readonly channels: ChannelApplicationService;
  readonly workflows: SessionWorkflowRunRepository;
  readonly retention: ApplicationRetentionService;

  private readonly eventPublisher: SessionEventPublisher;
  private readonly transcriptProjection: SessionTranscriptProjection;
  private readonly executionProjector: SessionExecutionProjector;
  private readonly liveChildren = new LiveChildAgentDirectory();
  private readonly operationGate = new DaemonOperationGate();
  private readonly agentPool: AgentPool;
  private readonly runEngine: SessionRunEngine;
  private readonly startupRecovery: Promise<void>;
  private closePromise?: Promise<void>;
  private readyState: "starting" | "ready" | "failed" | "closing" | "closed" = "starting";
  private ownerLease: ApplicationOwnerLease;
  private readonly ownerHeartbeat: ReturnType<typeof setInterval>;

  constructor(private readonly options: DaemonApplicationOptions) {
    const { store } = options;
    this.store = store;
    this.ownerLease = store.acquireApplicationOwner({
      ownerId: options.ownerId ?? `daemon:${process.pid}:${randomUUID()}`,
      pid: process.pid,
      staleAfterMs: options.ownerStaleAfterMs ?? 30_000,
    });
    this.ownerHeartbeat = setInterval(() => {
      try {
        this.ownerLease = store.heartbeatApplicationOwner(this.ownerLease);
      } catch (error) {
        clearInterval(this.ownerHeartbeat);
        this.readyState = "failed";
        options.log({
          level: "error",
          event: "application.owner_lost",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, options.ownerHeartbeatMs ?? 5_000);
    this.ownerHeartbeat.unref?.();
    try {
    recoverProjectionSettlements(store);
    store.interruptActiveRuns(DAEMON_RESTART_RUN_REASON);
    store.terminalizeUnownedInputs(DAEMON_RESTART_INPUT_REASON);
    store.interruptActiveSessionTasks(DAEMON_RESTART_TASK_REASON);
    store.expirePendingPermissionRequests(DAEMON_RESTART_PERMISSION_REASON);
    store.finalizeClosingSessions();

    this.events = new ApplicationEventService(store);
    this.eventPublisher = new SessionEventPublisher(store, this.events);
    this.workflows = new SessionWorkflowRunRepository(
      store,
      (previousEventSeq) => this.eventPublisher.publishSince(previousEventSeq),
    );
    this.retention = new ApplicationRetentionService(store);
    this.terminals = new DaemonTerminalService(store);
    this.projects = new ProjectApplicationService(store);
    this.permissions = new StorePermissionBroker({
      store,
      onChange: (previousEventSeq) =>
        this.eventPublisher.publishSince(previousEventSeq),
      logger: options.log,
    });
    this.transcriptProjection = new SessionTranscriptProjection(store);
    this.executionProjector = new SessionExecutionProjector({
      store,
      getChildAgentExecutionRegistry: (scope) => getChildAgentExecutionRegistry(scope),
      events: this.eventPublisher,
      traceIdForRun: (runId) => this.traceIdForRun(runId),
      log: options.log,
    });
    this.backgroundShells = new BackgroundShellService({
      store,
      executionProjector: this.executionProjector,
      getDetachedProcessSupervisor: (scope) => getDetachedProcessSupervisor(scope),
      events: this.eventPublisher,
    });
    this.jobs = new DaemonJobService(
      store,
      this.terminals,
      this.backgroundShells,
      (scope) => getDetachedProcessSupervisor(scope),
      (scope) => getChildAgentExecutionRegistry(scope),
      this.workflows,
    );

    const loadAgent = createDaemonAgentLoader({
      settings: options.settings,
      getSettings: options.getSettings,
      getSettingsForCwd: options.getSettingsForCwd,
      createAgent: options.createAgent,
      createTerminalHost:
        options.createTerminalHost ??
        ((session) => this.terminals.createAgentHost(session)),
      createJobHost:
        options.createJobHost ??
        ((session) => this.jobs.createAgentHost(session)),
      workflowRepository: this.workflows,
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
      createEventSink: (agent, session) => {
        const projector = new DaemonAgentEventProjector({
          projectorId: `${DAEMON_AGENT_PROJECTOR}:${agent.id}`,
          rootSessionId: session.id,
          rootAgent: agent,
          store,
          transcriptProjection: this.transcriptProjection,
          executionProjector: this.executionProjector,
          liveChildren: this.liveChildren,
          events: this.eventPublisher,
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
      events: this.eventPublisher,
      transcriptProjection: this.transcriptProjection,
      traceIdForRun: (runId) => this.traceIdForRun(runId),
      log: options.log,
    });
    this.runEngine = new SessionRunEngine({
      store,
      agentPool: this.agentPool,
      runExecutor,
      events: this.eventPublisher,
    });
    this.control = new DaemonControlService({
      store,
      runEngine: this.runEngine,
      agentPool: this.agentPool,
      operationGate: this.operationGate,
      startedAt: Date.now(),
      sseClientCount: () => this.events.subscriberCount,
    });
    this.maintenance = new SessionMaintenanceService({
      store,
      runEngine: this.runEngine,
      agentPool: this.agentPool,
      liveChildren: this.liveChildren,
      operationGate: this.operationGate,
      events: this.eventPublisher,
    });
    this.sessions = new SessionApplicationService({
      store,
      runEngine: this.runEngine,
      agentPool: this.agentPool,
      liveChildren: this.liveChildren,
      operationGate: this.operationGate,
      events: this.eventPublisher,
      assertReady: () => this.assertReady(),
    });
    this.channels = new ChannelApplicationService({
      store,
      sessions: this.sessions,
      log: options.log,
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
      workflows: this.workflows,
    }).then(
      () => {
        if (this.readyState === "starting") this.readyState = "ready";
      },
      (error) => {
        this.readyState = "failed";
        clearInterval(this.ownerHeartbeat);
        store.releaseApplicationOwner(this.ownerLease);
        throw error;
      },
    );
    void this.startupRecovery.catch(() => {});
    } catch (error) {
      clearInterval(this.ownerHeartbeat);
      store.releaseApplicationOwner(this.ownerLease);
      throw error;
    }
  }

  async ready(): Promise<void> {
    await this.startupRecovery;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.readyState = "closing";
    this.closePromise = this.closeWork();
    return this.closePromise;
  }

  private async closeWork(): Promise<void> {
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
    try {
      await this.terminals.dispose();
    } catch (error) {
      failures.push(error);
    }
    try {
      await closeExecutionRuntimes();
    } catch (error) {
      failures.push(error);
    }
    try {
      const settlementRecovery = recoverProjectionSettlements(this.options.store);
      if (settlementRecovery.pending > 0) {
        throw new Error(
          `Daemon shutdown left ${settlementRecovery.pending} projection settlement(s) pending`,
        );
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      this.events.close();
    } catch (error) {
      failures.push(error);
    }
    clearInterval(this.ownerHeartbeat);
    try {
      this.store.releaseApplicationOwner(this.ownerLease);
    } catch (error) {
      failures.push(error);
    }
    if (this.options.ownsStore) {
      try {
        this.store.close();
      } catch (error) {
        failures.push(error);
      }
    }
    this.readyState = "closed";
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Daemon application shutdown failed");
  }

  private assertReady(): void {
    if (this.readyState === "ready") return;
    if (this.readyState === "failed") {
      throw new Error("Durable Agent Application failed to start");
    }
    if (this.readyState === "closing" || this.readyState === "closed") {
      throw new Error("Durable Agent Application is closing or closed");
    }
    throw new Error("Durable Agent Application is not ready");
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
