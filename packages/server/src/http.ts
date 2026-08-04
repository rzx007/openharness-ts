import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";

import {
  SessionStore,
  getTaskManager,
  type SessionEventRecord,
} from "@openharness/services";

import type { CommandCatalogProvider } from "./commands.js";
import { getDefaultSessionStorePath } from "./paths.js";
import { StorePermissionBroker } from "./permission-broker.js";
import type { ChildSessionHost, SessionRuntimeFactory } from "./runtime.js";
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
  countByStatus,
  errorResponse,
  normalizeAllowedOrigins,
  normalizeTraceId,
  type JsonRecord,
  type OpenHarnessRuntimeSnapshot,
} from "./http-support.js";
import { createSystemRoutes } from "./http-system-routes.js";
import { createMemoryRoutes } from "./http-memory-routes.js";
import { createAuthRoutes } from "./http-auth-routes.js";
import { HttpEventHub } from "./http-events-routes.js";
import { createServiceRoutes } from "./http-service-routes.js";
import { createGitRoutes } from "./http-git-routes.js";
import { createPermissionRoutes } from "./http-permission-routes.js";
import { createRunExecutionRoutes } from "./http-run-execution-routes.js";
import { SessionRunRenderer } from "./http-run-renderer.js";
import { SessionTaskBridgeManager } from "./http-session-task-bridge.js";
import { createSessionRoutes } from "./http-session-routes.js";
import { createSessionUtilityRoutes } from "./http-session-utility-routes.js";
import { createTaskRoutes } from "./http-task-routes.js";
import { recoverInterruptedWorkflows } from "./http-workflow-recovery.js";
import { SessionRunEngine } from "./session-run-engine.js";

export interface OpenHarnessServerOptions {
  host?: string;
  port?: number;
  token?: string;
  /** Exact browser origins permitted to call this daemon. Empty means native/same-origin clients only. */
  allowedOrigins?: string[];
  store?: SessionStore;
  storePath?: string;
  runtimeFactory?: SessionRuntimeFactory;
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

export type { OpenHarnessRuntimeSnapshot, OpenHarnessServerHealth } from "./http-support.js";

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
  private readonly runtimeFactory?: SessionRuntimeFactory;
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
  private readonly permissionBroker: StorePermissionBroker;
  private readonly childSessionHost: ChildSessionHost;
  private readonly eventHub: HttpEventHub;
  private readonly runRenderer: SessionRunRenderer;
  private readonly sessionTaskBridgeManager: SessionTaskBridgeManager;
  private readonly runEngine: SessionRunEngine;
  private readonly archivePromises = new Map<string, Promise<ReturnType<SessionStore["archiveSession"]>>>();
  private readonly requestTraceIds = new WeakMap<Request, string>();
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
    this.runtimeFactory = options.runtimeFactory;
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
    this.permissionBroker = new StorePermissionBroker({
      store: this.store,
      onChange: (previousEventSeq) => this.broadcastSince(previousEventSeq),
      logger: (event) => this.log(event),
    });
    this.eventHub = new HttpEventHub(this.store);
    this.runRenderer = new SessionRunRenderer(this.store);
    this.sessionTaskBridgeManager = new SessionTaskBridgeManager({
      store: this.store,
      getTaskManager: (scope) => getTaskManager(scope),
      latestEventSeq: () => this.latestEventSeq(),
      broadcastSince: (seq) => this.broadcastSince(seq),
      traceIdForRun: (runId) => this.traceIdForRun(runId),
      log: (event) => this.log(event),
    });
    this.childSessionHost = {
      createChildSession: async (input) => this.createChildSession(input),
      admitPrompt: async (sessionId, content) => {
        const admitted = this.runEngine.admitPromptAndMaybeRun(sessionId, { content });
        return { ...(admitted.run ? { runId: admitted.run.id } : {}) };
      },
      awaitRun: async (sessionId, runId) => this.runEngine.awaitRun(sessionId, runId),
      interrupt: async (sessionId) => {
        this.runEngine.interruptSession(sessionId);
      },
      closeRuntime: async (sessionId) => this.runEngine.closeRuntime(sessionId),
      archive: async (sessionId) => {
        await this.archiveSessionTree(sessionId);
      },
    };
    this.runEngine = new SessionRunEngine({
      store: this.store,
      runtimeFactory: this.runtimeFactory,
      childSessionHost: this.childSessionHost,
      permissionBroker: this.permissionBroker,
      runRenderer: this.runRenderer,
      sessionTaskBridgeManager: this.sessionTaskBridgeManager,
      latestEventSeq: () => this.latestEventSeq(),
      broadcastSince: (seq) => this.broadcastSince(seq),
      broadcastEvent: (event) => this.broadcastEvent(event),
      traceIdForRun: (runId) => this.traceIdForRun(runId),
      log: (event) => this.log(event),
    });
    this.startupRecovery = recoverInterruptedWorkflows({
      store: this.store,
      latestEventSeq: () => this.latestEventSeq(),
      broadcastSince: (seq) => this.broadcastSince(seq),
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
    await this.runEngine.closeAllRuntimes();
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
      const traceId = normalizeTraceId(c.req.header(TRACE_ID_HEADER)) ?? randomUUID();
      const startedAt = Date.now();
      this.requestTraceIds.set(c.req.raw, traceId);
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
      runtimeSnapshot: () => this.runtimeSnapshot(),
      hasAnyActiveRuns: () => this.runEngine.hasAnyActiveRuns(),
      closeAllRuntimes: () => this.runEngine.closeAllRuntimes(),
    }));
    this.app.route("/memory", createMemoryRoutes({
      memoryService: this.memoryService,
      hasActiveRunsForCwd: (cwd) => this.runEngine.hasActiveRunsForCwd(cwd),
      closeRuntimesForCwd: (cwd) => this.runEngine.closeRuntimesForCwd(cwd),
    }));
    this.app.route("/auth", createAuthRoutes({
      authService: this.authService,
      hasAnyActiveRuns: () => this.runEngine.hasAnyActiveRuns(),
      closeAllRuntimes: () => this.runEngine.closeAllRuntimes(),
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
      hasAnyActiveRuns: () => this.runEngine.hasAnyActiveRuns(),
      hasActiveRunsForCwd: (cwd) => this.runEngine.hasActiveRunsForCwd(cwd),
      closeAllRuntimes: () => this.runEngine.closeAllRuntimes(),
      closeRuntimesForCwd: (cwd) => this.runEngine.closeRuntimesForCwd(cwd),
      sessionExists: (sessionId) => this.store.getSession(sessionId) !== undefined,
      inspectRuntimeHooks: this.runtimeFactory
        ? async (sessionId) => {
            await this.runEngine.warmRuntime(sessionId);
            const runtime = await this.runEngine.runtimeForSession(sessionId);
            if (!runtime?.inspect) return [];
            return (await runtime.inspect()).hooks ?? [];
          }
        : undefined,
    }));
    this.app.route("/git", createGitRoutes({ gitService: this.gitService }));
    this.app.route("/tasks", createTaskRoutes({
      getSession: (sessionId) => this.store.getSession(sessionId),
      listSessionTasks: (sessionId) => this.store.listSessionTasks(sessionId),
      getSessionTask: (taskId) => this.store.getSessionTask(taskId),
      createSessionTask: (input) => this.store.createSessionTask(input),
      latestEventSeq: () => this.latestEventSeq(),
      broadcastSince: (seq) => this.broadcastSince(seq),
      projectManagerTasks: (sessionId, manager) => this.sessionTaskBridgeManager.projectManagerTasks(sessionId, manager),
      trackTask: (manager, taskId) => this.sessionTaskBridgeManager.trackTask(manager, taskId),
      syncPersistentTask: (task, manager, persistedId) =>
        this.sessionTaskBridgeManager.syncPersistentTask(task, manager, persistedId),
    }));
    this.app.route("/permissions", createPermissionRoutes({
      listRequests: (input) => this.permissionBroker.listRequests(input),
      reply: (input) => this.permissionBroker.reply(input),
      traceIdForRequest: (request) => this.traceIdForRequest(request),
    }));
    this.app.route("/sessions", createSessionUtilityRoutes({
      store: this.store,
      runtimeFactory: this.runtimeFactory,
      hasRunWork: (sessionId) => this.runEngine.hasWork(sessionId),
      hasActiveRunsForCwd: (cwd) => this.runEngine.hasActiveRunsForCwd(cwd),
      warmRuntime: (sessionId) => this.runEngine.warmRuntime(sessionId),
      runtimeForSession: (sessionId) => this.runEngine.runtimeForSession(sessionId),
      latestEventSeq: () => this.latestEventSeq(),
      broadcastSince: (seq) => this.broadcastSince(seq),
      closeRuntime: (sessionId) => this.runEngine.closeRuntime(sessionId),
      closeRuntimesForCwd: (cwd) => this.runEngine.closeRuntimesForCwd(cwd),
    }));
    this.app.route("/sessions", createSessionRoutes({
      store: this.store,
      commandCatalog: this.commandCatalog,
      latestEventSeq: () => this.latestEventSeq(),
      broadcastSince: (seq) => this.broadcastSince(seq),
      warmRuntime: (sessionId) => this.runEngine.warmRuntime(sessionId),
      hasRunWork: (sessionId) => this.runEngine.hasWork(sessionId),
      closeRuntime: (sessionId) => this.runEngine.closeRuntime(sessionId),
      archiveSessionTree: (sessionId) => this.archiveSessionTree(sessionId),
      traceIdForRequest: (request) => this.traceIdForRequest(request),
      admitPromptAndMaybeRun: (sessionId, input) => this.runEngine.admitPromptAndMaybeRun(sessionId, input),
    }));
    this.app.route("/sessions", createRunExecutionRoutes({
      store: this.store,
      hasRuntime: () => Boolean(this.runtimeFactory),
      hasRunWork: (sessionId) => this.runEngine.hasWork(sessionId),
      latestEventSeq: () => this.latestEventSeq(),
      broadcastSince: (seq) => this.broadcastSince(seq),
      traceIdForRequest: (request) => this.traceIdForRequest(request),
      admitPromptAndMaybeRun: (sessionId, input) => this.runEngine.admitPromptAndMaybeRun(sessionId, input),
      interruptSession: (sessionId) => this.runEngine.interruptSession(sessionId),
    }));
    this.app.route("/events", this.eventHub.createRoutes());
  }

  private authorized(c: Context): boolean {
    if (!this.token) return true;
    return c.req.header("authorization") === `Bearer ${this.token}`;
  }

  private traceIdForRequest(request: Request): string {
    return this.requestTraceIds.get(request) ?? randomUUID();
  }

  private log(event: ObservabilityEvent): void {
    this.logger(event);
  }

  private runtimeSnapshot(): OpenHarnessRuntimeSnapshot {
    const sessions = this.store.listSessions({ includeArchived: true });
    const runs = sessions.flatMap((session) => this.store.listRuns(session.id));
    const tasks = sessions.flatMap((session) => this.store.listSessionTasks(session.id));
    const permissions = this.store.listPermissionRequests();
    const activeRunCount = sessions.filter((session) => this.runEngine.activeRunId(session.id) !== undefined).length;
    const queuedRunCount = sessions.reduce(
      (count, session) => count + this.runEngine.queuedRunIds(session.id).length,
      0,
    );
    const now = Date.now();
    return {
      startedAt: this.startedAt,
      uptimeMs: now - this.startedAt,
      sessions: { total: sessions.length, byStatus: countByStatus(sessions) },
      runs: { total: runs.length, byStatus: countByStatus(runs) },
      tasks: { total: tasks.length, byStatus: countByStatus(tasks) },
      permissions: {
        total: permissions.length,
        byStatus: countByStatus(permissions),
      },
      sseClientCount: this.eventHub.clientCount,
      warmRuntimeCount: this.runEngine.warmRuntimeCount,
      coordinator: { activeRunCount, queuedRunCount },
    };
  }

  private traceIdForRun(runId: string): string {
    const run = this.store.getRun(runId);
    const traceId = normalizeTraceId(run?.metadata.traceId);
    if (traceId) return traceId;
    const generated = randomUUID();
    if (run) this.store.updateRun(runId, { metadata: { traceId: generated } });
    return generated;
  }

  private async createChildSession(
    input: Parameters<ChildSessionHost["createChildSession"]>[0],
  ): ReturnType<ChildSessionHost["createChildSession"]> {
    if (!this.store.getSession(input.parentId)) {
      throw new Error(`Parent session not found: ${input.parentId}`);
    }
    const parent = this.store.getSession(input.parentId)!;
    const before = this.latestEventSeq();
    const session = this.store.createSession({
      ...input,
      model: input.model ?? parent.model,
    });
    this.broadcastSince(before);
    await this.runEngine.warmRuntime(session.id);
    return session;
  }

  private async archiveSessionTree(sessionId: string): Promise<ReturnType<SessionStore["archiveSession"]>> {
    const existing = this.archivePromises.get(sessionId);
    if (existing) return await existing;
    const archive = this.archiveSessionTreeWork(sessionId).finally(() => {
      if (this.archivePromises.get(sessionId) === archive) this.archivePromises.delete(sessionId);
    });
    this.archivePromises.set(sessionId, archive);
    return await archive;
  }

  private async archiveSessionTreeWork(sessionId: string): Promise<ReturnType<SessionStore["archiveSession"]>> {
    const children = this.store.listChildSessions(sessionId);
    for (const child of children) await this.archiveSessionTree(child.id);

    const beforeClosing = this.latestEventSeq();
    const current = this.store.getSession(sessionId);
    if (!current) throw new Error(`Session not found: ${sessionId}`);
    if (current.status === "archived") return current;
    this.store.beginArchive(sessionId);
    this.broadcastSince(beforeClosing);
    const interrupted = this.runEngine.interruptSession(sessionId);
    const interruptedRunIds = [interrupted.activeRunId, ...interrupted.queuedRunIds]
      .filter((runId): runId is string => !!runId);
    await this.runEngine.waitForRuns(interruptedRunIds);
    await this.runEngine.closeRuntime(sessionId);
    const before = this.latestEventSeq();
    const session = this.store.archiveSession(sessionId);
    this.broadcastSince(before);
    return session;
  }

  private latestEventSeq(): number {
    return this.store.latestEventSeq();
  }

  private broadcastSince(seq: number): void {
    this.eventHub.broadcastSince(seq);
  }

  private broadcastEvent(event: SessionEventRecord): void {
    this.eventHub.broadcastEvent(event);
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
