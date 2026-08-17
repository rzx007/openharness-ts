import { randomUUID } from "node:crypto";

import type { Settings } from "@openharness/core";
import type { AgentTerminalHost } from "@openharness/terminal";
import type { AgentJobHost } from "@openharness/jobs";
import type { SessionRecord } from "@openharness/services";
import { getTaskManager, type SessionStore } from "@openharness/services";

import {
  createDaemonAgentLoader,
  type CreateDaemonAgent,
} from "../daemon/daemon-agent.js";
import { DaemonCronService } from "../daemon/daemon-cron-service.js";
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
  readonly cron: DaemonCronService;

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

    this.cron = new DaemonCronService({
      store,
      getSettingsForCwd:
        options.getSettingsForCwd ??
        (async () => {
          const settings = options.getSettings?.() ?? options.settings;
          if (!settings) throw new Error("Daemon settings are unavailable");
          return settings;
        }),
    });

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
      cron: {
        save: async (input) => this.cron.saveJob(input),
        remove: async (name) => {
          this.cron.removeJob(name);
        },
        list: async () => this.cron.listJobs(),
        setEnabled: async (name, enabled) =>
          this.cron.setEnabled(name, enabled),
        trigger: async (name) => this.cron.trigger(name),
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
      await this.cron.shutdown();
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
