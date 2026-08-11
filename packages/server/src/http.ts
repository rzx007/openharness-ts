import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";

import {
  SessionStore,
  getTaskManager,
} from "@openharness/services";
import type { Settings } from "@openharness/core";

import type { CommandCatalogProvider } from "./commands.js";
import { getDefaultSessionStorePath } from "./paths.js";
import { StorePermissionBroker } from "./permission-broker.js";
import type {
  AgentPersonaService,
  AuthService,
  ContextService,
  DreamService,
  GitService,
  HooksService,
  MemoryService,
  OutputStyleService,
  PluginService,
  ProfileService,
  ProjectInitService,
  ProviderService,
  SettingsService,
} from "./settings-api.js";
import {
  TRACE_ID_HEADER,
  writeStructuredLog,
  type ObservabilityEvent,
  type StructuredLogger,
} from "./observability.js";
import {
  CORS_HEADERS,
  CORS_METHODS,
  DAEMON_RESTART_RUN_REASON,
  DAEMON_RESTART_TASK_REASON,
  errorResponse,
  normalizeAllowedOrigins,
  normalizeTraceId,
  type JsonRecord,
} from "./http/support.js";
import { createAuthRoutes } from "./http/routes/auth.js";
import { HttpEventHub } from "./http/routes/events.js";
import { createGitRoutes } from "./http/routes/git.js";
import { createMemoryRoutes } from "./http/routes/memory.js";
import { createPermissionRoutes } from "./http/routes/permission.js";
import { createRunExecutionRoutes } from "./http/routes/run-execution.js";
import { createServiceRoutes } from "./http/routes/service.js";
import { createSessionRoutes } from "./http/routes/session.js";
import { createSessionUtilityRoutes } from "./http/routes/session-utility.js";
import { createSystemRoutes } from "./http/routes/system.js";
import { createTaskRoutes } from "./http/routes/task.js";
import { DaemonAgentEventProjector } from "./http/daemon-agent-event-projector.js";
import { DaemonControlService } from "./http/daemon-control-service.js";
import { RequestTraceRegistry } from "./http/request-trace-registry.js";
import { SessionApplicationService } from "./http/session-application-service.js";
import { SessionEventPublisher } from "./http/session-event-publisher.js";
import { SessionMaintenanceService } from "./http/session-maintenance-service.js";
import { SessionQueryService } from "./http/session-query-service.js";
import { SessionRunEngine } from "./http/session-run-engine.js";
import { SessionRunExecutor } from "./http/session-run-executor.js";
import { AgentPool, type CreateDaemonAgent } from "./http/agent-pool.js";
import { SessionTaskBridgeManager } from "./http/session-task-bridge.js";
import { SessionTaskService } from "./http/session-task-service.js";
import { LiveChildAgentDirectory } from "./http/live-child-agent-directory.js";
import { SessionTranscriptProjection } from "./http/transcript-projection.js";
import { recoverInterruptedWorkflows } from "./http/workflow-recovery.js";

export interface OpenHarnessServerOptions {
  host?: string;
  port?: number;
  token?: string;
  /** Exact browser origins permitted to call this daemon. Empty means native/same-origin clients only. */
  allowedOrigins?: string[];
  store?: SessionStore;
  storePath?: string;
  settings?: Settings;
  getSettings?: () => Settings;
  /** Test/embedding seam. Production daemon creation uses createOpenHarnessAgent directly. */
  createAgent?: CreateDaemonAgent;
  commandCatalog?: CommandCatalogProvider;
  settingsService?: SettingsService;
  providerService?: ProviderService;
  memoryService?: MemoryService;
  authService?: AuthService;
  contextService?: ContextService;
  dreamService?: DreamService;
  profileService?: ProfileService;
  outputStyleService?: OutputStyleService;
  projectInitService?: ProjectInitService;
  pluginService?: PluginService;
  agentPersonaService?: AgentPersonaService;
  hooksService?: HooksService;
  gitService?: GitService;
  version?: string;
  logger?: StructuredLogger;
}

export type { OpenHarnessRuntimeSnapshot, OpenHarnessServerHealth } from "./http/support.js";

export interface ListenResult {
  host: string;
  port: number;
  url: string;
}

type Listener = ReturnType<typeof serve>;

export class OpenHarnessHttpServer {
  readonly app: Hono;
  readonly store: SessionStore;
  readonly token?: string;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly commandCatalog?: CommandCatalogProvider;
  private readonly settingsService?: SettingsService;
  private readonly providerService?: ProviderService;
  private readonly memoryService?: MemoryService;
  private readonly authService?: AuthService;
  private readonly contextService?: ContextService;
  private readonly dreamService?: DreamService;
  private readonly profileService?: ProfileService;
  private readonly outputStyleService?: OutputStyleService;
  private readonly projectInitService?: ProjectInitService;
  private readonly pluginService?: PluginService;
  private readonly agentPersonaService?: AgentPersonaService;
  private readonly hooksService?: HooksService;
  private readonly gitService?: GitService;
  private readonly version?: string;
  private readonly logger: StructuredLogger;
  /** 权限 ask/reply 中介（store 持久化 + 等待客户端裁决）。 */
  private readonly permissionBroker: StorePermissionBroker;
  private readonly eventHub: HttpEventHub;
  private readonly sessionEvents: SessionEventPublisher;
  /** AgentEvent -> durable transcript projection helper. */
  private readonly transcriptProjection: SessionTranscriptProjection;
  /** 进程内 TaskManager ↔ store SessionTask 投影桥。 */
  private readonly sessionTaskBridgeManager: SessionTaskBridgeManager;
  private readonly sessionTaskService: SessionTaskService;
  /** Durable child session id -> framework child directory routing. */
  private readonly liveChildren = new LiveChildAgentDirectory();
  /** 每个 durable session 一份 warm OpenHarnessAgent。 */
  private readonly agentPool: AgentPool;
  /** Prompt 准入 + session lane 调度（queue/steer/interrupt）。 */
  private readonly runEngine: SessionRunEngine;
  /** Session 写路径用例：create/admit/archive/child/resume 等。 */
  private readonly sessionApplication: SessionApplicationService;
  /** Session 维护：compact/rewind/export/remember/MCP·usage 检查。 */
  private readonly sessionMaintenance: SessionMaintenanceService;
  /** Session 只读查询：列表/详情/messages。 */
  private readonly sessionQueries: SessionQueryService;
  /** Daemon 控制面：快照、关 runtime、活跃 run barrier。 */
  private readonly daemonControl: DaemonControlService;
  private readonly requestTraces = new RequestTraceRegistry();
  private readonly startupRecovery: Promise<void>;
  private readonly startedAt = Date.now();
  private listener?: Listener;
  private listenResult?: ListenResult;

  constructor(options: OpenHarnessServerOptions = {}) {
    this.app = new Hono();
    this.store = options.store ?? new SessionStore({ path: options.storePath ?? getDefaultSessionStorePath() });
    this.store.interruptActiveRuns(DAEMON_RESTART_RUN_REASON);
    this.store.interruptActiveSessionTasks(DAEMON_RESTART_TASK_REASON);
    this.store.finalizeClosingSessions();
    this.token = options.token;
    this.allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins ?? []);
    this.commandCatalog = options.commandCatalog;
    this.settingsService = options.settingsService;
    this.providerService = options.providerService;
    this.memoryService = options.memoryService;
    this.authService = options.authService;
    this.contextService = options.contextService;
    this.dreamService = options.dreamService;
    this.profileService = options.profileService;
    this.outputStyleService = options.outputStyleService;
    this.projectInitService = options.projectInitService;
    this.pluginService = options.pluginService;
    this.agentPersonaService = options.agentPersonaService;
    this.hooksService = options.hooksService;
    this.gitService = options.gitService;
    this.version = options.version;
    this.logger = options.logger ?? writeStructuredLog;
    this.eventHub = new HttpEventHub(this.store);
    this.sessionEvents = new SessionEventPublisher(this.store, this.eventHub);
    this.permissionBroker = new StorePermissionBroker({
      store: this.store,
      onChange: (previousEventSeq) => this.sessionEvents.publishSince(previousEventSeq),
      logger: (event) => this.log(event),
    });
    this.transcriptProjection = new SessionTranscriptProjection(this.store);
    this.sessionTaskBridgeManager = new SessionTaskBridgeManager({
      store: this.store,
      getTaskManager: (scope) => getTaskManager(scope),
      events: this.sessionEvents,
      traceIdForRun: (runId) => this.traceIdForRun(runId),
      log: (event) => this.log(event),
    });
    this.sessionTaskService = new SessionTaskService({
      store: this.store,
      bridgeManager: this.sessionTaskBridgeManager,
      getTaskManager: (scope) => getTaskManager(scope),
      events: this.sessionEvents,
    });
    this.agentPool = new AgentPool({
      store: this.store,
      settings: options.settings,
      getSettings: options.getSettings,
      createAgent: options.createAgent,
      isSessionExternallyOwned: (sessionId) => this.liveChildren.has(sessionId),
      effects: {
        requestPermission: async (request, context) => {
          const approved = await this.permissionBroker.ask({
            sessionId: context.sessionId,
            runId: context.runId,
            traceId: context.traceId,
            toolName: request.toolName,
            reason: request.reason,
            input: request.input,
            signal: context.signal,
          });
          return approved ? { status: "approved" } : { status: "denied" };
        },
      },
      bindAgent: (agent) => {
        const projector = new DaemonAgentEventProjector({
          rootAgent: agent,
          store: this.store,
          transcriptProjection: this.transcriptProjection,
          taskBridgeManager: this.sessionTaskBridgeManager,
          liveChildren: this.liveChildren,
          events: this.sessionEvents,
          log: (event) => this.log(event),
        });
        return agent.events.subscribe((event) => projector.apply(event));
      },
    });
    // 单次 run 执行：agent.submitMessage -> AgentRunHandle；事件在 pool binding 中统一落库。
    const runExecutor = new SessionRunExecutor({
      store: this.store,
      agentPool: this.agentPool,
      events: this.sessionEvents,
      traceIdForRun: (runId) => this.traceIdForRun(runId),
      log: (event) => this.log(event),
    });
    this.runEngine = new SessionRunEngine({
      store: this.store,
      agentPool: this.agentPool,
      runExecutor,
      events: this.sessionEvents,
    });
    this.daemonControl = new DaemonControlService({
      store: this.store,
      runEngine: this.runEngine,
      agentPool: this.agentPool,
      startedAt: this.startedAt,
      sseClientCount: () => this.eventHub.clientCount,
    });
    this.sessionMaintenance = new SessionMaintenanceService({
      store: this.store,
      runEngine: this.runEngine,
      agentPool: this.agentPool,
      liveChildren: this.liveChildren,
      events: this.sessionEvents,
    });
    this.sessionApplication = new SessionApplicationService({
      store: this.store,
      runEngine: this.runEngine,
      agentPool: this.agentPool,
      liveChildren: this.liveChildren,
      events: this.sessionEvents,
    });
    this.sessionQueries = new SessionQueryService(this.store);
    this.startupRecovery = recoverInterruptedWorkflows({
      store: this.store,
      events: this.sessionEvents,
    });
    this.mountRoutes();
  }

  get url(): string | undefined {
    return this.listenResult?.url;
  }

  async listen(options: Pick<OpenHarnessServerOptions, "host" | "port"> = {}): Promise<ListenResult> {
    await this.startupRecovery;
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 0;
    return await new Promise<ListenResult>((resolve, reject) => {
      const listener = serve(
        {
          fetch: this.app.fetch,
          hostname: host,
          port,
        },
        (info) => {
          this.listener = listener;
          this.listenResult = {
            host,
            port: info.port,
            url: `http://${host}:${info.port}`,
          };
          resolve(this.listenResult);
        },
      );
      listener.once("error", reject);
    });
  }

  async close(): Promise<void> {
    this.eventHub.closeClients();
    await this.daemonControl.closeAllRuntimes();
    if (this.listener) {
      await new Promise<void>((resolve, reject) => {
        this.listener!.close((error?: Error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      this.listener = undefined;
    }
    this.store.close();
  }

  private mountRoutes(): void {
    this.app.onError((error) => errorResponse(500, error instanceof Error ? error.message : String(error)));

    this.app.use("*", async (c, next) => {
      const traceId = this.requestTraces.assign(c.req.raw, c.req.header(TRACE_ID_HEADER));
      const startedAt = Date.now();
      try {
        await next();
      } finally {
        c.res.headers.set(TRACE_ID_HEADER, traceId);
        this.log({
          level: "info",
          event: "http.request.completed",
          traceId,
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          durationMs: Date.now() - startedAt,
        });
      }
    });

    this.app.use("*", async (c, next) => {
      const origin = c.req.header("origin");
      if (!origin) {
        await next();
        return;
      }
      if (!this.allowedOrigins.has(origin)) return errorResponse(403, "Origin is not allowed");
      const headers = {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": CORS_METHODS,
        "access-control-allow-headers": CORS_HEADERS,
        "access-control-expose-headers": TRACE_ID_HEADER,
        "access-control-max-age": "600",
        vary: "Origin",
      };
      if (c.req.method === "OPTIONS") return new Response(null, { status: 204, headers });
      await next();
      for (const [name, value] of Object.entries(headers)) c.res.headers.set(name, value);
    });

    this.app.use("*", async (c, next) => {
      if (!this.authorized(c)) return errorResponse(401, "Unauthorized");
      await next();
    });

    this.app.route("/", createSystemRoutes({
      version: this.version,
      commandCatalog: this.commandCatalog,
      settingsService: this.settingsService,
      providerService: this.providerService,
      control: this.daemonControl,
    }));
    this.app.route("/memory", createMemoryRoutes({
      memoryService: this.memoryService,
      control: this.daemonControl,
    }));
    this.app.route("/auth", createAuthRoutes({
      authService: this.authService,
      control: this.daemonControl,
    }));
    this.app.route("/", createServiceRoutes({
      contextService: this.contextService,
      dreamService: this.dreamService,
      profileService: this.profileService,
      outputStyleService: this.outputStyleService,
      projectInitService: this.projectInitService,
      pluginService: this.pluginService,
      agentPersonaService: this.agentPersonaService,
      hooksService: this.hooksService,
      control: this.daemonControl,
    }));
    this.app.route("/git", createGitRoutes({ gitService: this.gitService }));
    this.app.route("/tasks", createTaskRoutes({
      tasks: this.sessionTaskService,
    }));
    this.app.route("/permissions", createPermissionRoutes({
      permissions: this.permissionBroker,
      traces: this.requestTraces,
    }));
    this.app.route("/sessions", createSessionUtilityRoutes({
      maintenance: this.sessionMaintenance,
    }));
    this.app.route("/sessions", createSessionRoutes({
      queries: this.sessionQueries,
      application: this.sessionApplication,
      commandCatalog: this.commandCatalog,
      traces: this.requestTraces,
    }));
    this.app.route("/sessions", createRunExecutionRoutes({
      application: this.sessionApplication,
      traces: this.requestTraces,
    }));
    this.app.route("/events", this.eventHub.createRoutes());
  }

  private authorized(c: Context): boolean {
    if (!this.token) return true;
    return c.req.header("authorization") === `Bearer ${this.token}`;
  }

  private log(event: ObservabilityEvent): void {
    this.logger(event);
  }

  private traceIdForRun(runId: string): string {
    const run = this.store.getRun(runId);
    const traceId = normalizeTraceId(run?.metadata.traceId);
    if (traceId) return traceId;
    const generated = randomUUID();
    if (run) this.store.updateRun(runId, { metadata: { traceId: generated } });
    return generated;
  }

}

export async function startOpenHarnessServer(options: OpenHarnessServerOptions = {}): Promise<{
  server: OpenHarnessHttpServer;
  listen: ListenResult;
}> {
  const server = new OpenHarnessHttpServer(options);
  const listen = await server.listen(options);
  return { server, listen };
}
