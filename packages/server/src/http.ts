import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";

import type { StreamEvent } from "@openharness/core";
import {
  SessionStore,
  getTaskManager,
  type TaskInfo,
  type SessionEventRecord,
} from "@openharness/services";

import type { CommandCatalogProvider } from "./commands.js";
import { getDefaultSessionStorePath } from "./paths.js";
import { StorePermissionBroker } from "./permission-broker.js";
import { RunInterruptedError, SessionRunCoordinator } from "./run-coordinator.js";
import type { ChildSessionHost, SessionRuntime, SessionRuntimeFactory } from "./runtime.js";
import type { SessionTaskBridge } from "./runtime.js";
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
  jsonEqual,
  normalizeAllowedOrigins,
  normalizeTraceId,
  withoutTraceId,
  type ActiveRunRenderState,
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
import { createSessionRoutes } from "./http-session-routes.js";
import { createSessionUtilityRoutes } from "./http-session-utility-routes.js";
import { createTaskRoutes } from "./http-task-routes.js";
import { recoverInterruptedWorkflows } from "./http-workflow-recovery.js";

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
  private readonly runCoordinator = new SessionRunCoordinator();
  private readonly runtimes = new Map<string, Promise<SessionRuntime>>();
  private readonly runPromises = new Map<string, Promise<void>>();
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
    this.childSessionHost = {
      createChildSession: async (input) => this.createChildSession(input),
      admitPrompt: async (sessionId, content) => {
        const admitted = this.admitPromptAndMaybeRun(sessionId, { content });
        return { ...(admitted.run ? { runId: admitted.run.id } : {}) };
      },
      awaitRun: async (sessionId, runId) => this.awaitChildRun(sessionId, runId),
      interrupt: async (sessionId) => {
        this.interruptSession(sessionId);
      },
      closeRuntime: async (sessionId) => this.closeRuntime(sessionId),
      archive: async (sessionId) => {
        await this.archiveSessionTree(sessionId);
      },
    };
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
    await this.closeAllRuntimes();
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
      hasAnyActiveRuns: () => this.hasAnyActiveRuns(),
      closeAllRuntimes: () => this.closeAllRuntimes(),
    }));
    this.app.route("/memory", createMemoryRoutes({
      memoryService: this.memoryService,
      hasActiveRunsForCwd: (cwd) => this.hasActiveRunsForCwd(cwd),
      closeRuntimesForCwd: (cwd) => this.closeRuntimesForCwd(cwd),
    }));
    this.app.route("/auth", createAuthRoutes({
      authService: this.authService,
      hasAnyActiveRuns: () => this.hasAnyActiveRuns(),
      closeAllRuntimes: () => this.closeAllRuntimes(),
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
      hasAnyActiveRuns: () => this.hasAnyActiveRuns(),
      hasActiveRunsForCwd: (cwd) => this.hasActiveRunsForCwd(cwd),
      closeAllRuntimes: () => this.closeAllRuntimes(),
      closeRuntimesForCwd: (cwd) => this.closeRuntimesForCwd(cwd),
      sessionExists: (sessionId) => this.store.getSession(sessionId) !== undefined,
      inspectRuntimeHooks: this.runtimeFactory
        ? async (sessionId) => {
            await this.warmRuntime(sessionId);
            const runtime = this.runtimes.get(sessionId) ? await this.runtimes.get(sessionId)! : undefined;
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
      projectManagerTasks: (sessionId, manager) => this.projectManagerTasks(sessionId, manager),
      trackTask: (manager, taskId) => this.trackTask(manager, taskId),
      syncPersistentTask: (task, manager, persistedId) => this.syncPersistentTask(task, manager, persistedId),
    }));
    this.app.route("/permissions", createPermissionRoutes({
      listRequests: (input) => this.permissionBroker.listRequests(input),
      reply: (input) => this.permissionBroker.reply(input),
      traceIdForRequest: (request) => this.traceIdForRequest(request),
    }));
    this.app.route("/sessions", createSessionUtilityRoutes({
      store: this.store,
      runtimeFactory: this.runtimeFactory,
      hasRunWork: (sessionId) => this.runCoordinator.hasWork(sessionId),
      hasActiveRunsForCwd: (cwd) => this.hasActiveRunsForCwd(cwd),
      warmRuntime: (sessionId) => this.warmRuntime(sessionId),
      runtimeForSession: async (sessionId) =>
        this.runtimes.get(sessionId) ? await this.runtimes.get(sessionId)! : undefined,
      latestEventSeq: () => this.latestEventSeq(),
      broadcastSince: (seq) => this.broadcastSince(seq),
      closeRuntime: (sessionId) => this.closeRuntime(sessionId),
      closeRuntimesForCwd: (cwd) => this.closeRuntimesForCwd(cwd),
    }));
    this.app.route("/sessions", createSessionRoutes({
      store: this.store,
      commandCatalog: this.commandCatalog,
      latestEventSeq: () => this.latestEventSeq(),
      broadcastSince: (seq) => this.broadcastSince(seq),
      warmRuntime: (sessionId) => this.warmRuntime(sessionId),
      hasRunWork: (sessionId) => this.runCoordinator.hasWork(sessionId),
      closeRuntime: (sessionId) => this.closeRuntime(sessionId),
      archiveSessionTree: (sessionId) => this.archiveSessionTree(sessionId),
      traceIdForRequest: (request) => this.traceIdForRequest(request),
      admitPromptAndMaybeRun: (sessionId, input) => this.admitPromptAndMaybeRun(sessionId, input),
    }));
    this.app.route("/sessions", createRunExecutionRoutes({
      store: this.store,
      hasRuntime: () => Boolean(this.runtimeFactory),
      hasRunWork: (sessionId) => this.runCoordinator.hasWork(sessionId),
      latestEventSeq: () => this.latestEventSeq(),
      broadcastSince: (seq) => this.broadcastSince(seq),
      traceIdForRequest: (request) => this.traceIdForRequest(request),
      admitPromptAndMaybeRun: (sessionId, input) => this.admitPromptAndMaybeRun(sessionId, input),
      interruptSession: (sessionId) => this.interruptSession(sessionId),
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
    const activeRunCount = sessions.filter((session) => this.runCoordinator.activeRunId(session.id) !== undefined).length;
    const queuedRunCount = sessions.reduce(
      (count, session) => count + this.runCoordinator.queuedRunIds(session.id).length,
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
      warmRuntimeCount: this.runtimes.size,
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

  private async closeRuntimesForCwd(cwd: string): Promise<void> {
    const sessions = this.store.listSessions({ cwd, includeArchived: true });
    await Promise.all(sessions.map((session) => this.closeRuntime(session.id)));
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
    await this.warmRuntime(session.id);
    return session;
  }

  private async awaitChildRun(
    sessionId: string,
    runId: string,
  ): ReturnType<ChildSessionHost["awaitRun"]> {
    const initial = this.store.getRun(runId);
    if (!initial || initial.sessionId !== sessionId) throw new Error(`Session run not found: ${runId}`);
    if (initial.status === "pending" || initial.status === "running") {
      await this.runPromises.get(runId);
    }
    const run = this.store.getRun(runId);
    if (!run || run.sessionId !== sessionId) throw new Error(`Session run not found: ${runId}`);
    if (run.status === "pending" || run.status === "running") {
      throw new Error(`Session run is still active: ${runId}`);
    }
    const output = this.store.listMessages(sessionId)
      .filter((message) => message.runId === runId && message.role === "assistant")
      .flatMap((message) => this.store.listMessageParts(sessionId, { messageId: message.id }))
      .map((part) => {
        if (part.text) return part.text;
        if (part.output == null) return "";
        return typeof part.output === "string" ? part.output : JSON.stringify(part.output);
      })
      .filter(Boolean)
      .join("\n");
    return {
      status: run.status,
      output,
      ...(run.error ? { error: run.error } : {}),
    };
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
    const interrupted = this.interruptSession(sessionId);
    const interruptedRunIds = [interrupted.activeRunId, ...interrupted.queuedRunIds]
      .filter((runId): runId is string => !!runId);
    await Promise.all(interruptedRunIds
      .map((runId) => this.runPromises.get(runId))
      .filter((promise): promise is Promise<void> => promise !== undefined));
    await this.closeRuntime(sessionId);
    const before = this.latestEventSeq();
    const session = this.store.archiveSession(sessionId);
    this.broadcastSince(before);
    return session;
  }

  private admitPromptAndMaybeRun(
    sessionId: string,
    input: {
      id?: string;
      delivery?: "queue" | "steer";
      content: string;
      metadata?: Record<string, unknown>;
      runMetadata?: Record<string, unknown>;
      traceId?: string;
    },
  ): {
    input: ReturnType<SessionStore["admitPrompt"]>;
    run?: ReturnType<SessionStore["createRun"]>;
    queue_state?: "running" | "queued";
  } {
    const delivery = input.delivery ?? "queue";
    const traceId = normalizeTraceId(input.traceId) ?? normalizeTraceId(input.metadata?.traceId) ?? randomUUID();
    const metadata = { ...(input.metadata ?? {}), traceId };
    const runMetadata = { ...(input.runMetadata ?? {}), traceId };
    const existingInput = input.id ? this.store.getInput(input.id) : undefined;
    if (existingInput) {
      if (
        existingInput.sessionId !== sessionId ||
        existingInput.content !== input.content ||
        existingInput.delivery !== delivery ||
        !jsonEqual(withoutTraceId(existingInput.metadata), withoutTraceId(metadata))
      ) {
        throw new Error(`Prompt id is already used: ${input.id}`);
      }
      const existingRun = this.store.findRunByInput(existingInput.id);
      return {
        input: existingInput,
        ...(existingRun ? { run: existingRun } : {}),
        ...(existingRun?.status === "running" ? { queue_state: "running" as const } : {}),
        ...(existingRun?.status === "pending" ? { queue_state: "queued" as const } : {}),
      };
    }

    const before = this.latestEventSeq();
    const admitted = this.store.admitPrompt({
      id: input.id,
      sessionId,
      delivery,
      content: input.content,
      metadata,
    });

    if (delivery === "steer" && this.runtimeFactory) {
      const activeRunId = this.runCoordinator.activeRunId(sessionId);
      if (activeRunId) {
        this.broadcastSince(before);
        this.runCoordinator.mergeWake(sessionId);
        const activeRun = this.store.getRun(activeRunId);
        return {
          input: admitted,
          ...(activeRun ? { run: activeRun, queue_state: "running" as const } : {}),
        };
      }
    }

    const run = this.runtimeFactory
      ? this.store.createRun({ sessionId, inputId: admitted.id, metadata: runMetadata })
      : undefined;
    this.broadcastSince(before);
    let queueState: "running" | "queued" | undefined;
    if (run) {
      const enqueued = this.runCoordinator.enqueue({
        sessionId,
        runId: run.id,
        work: (context) => this.executeRun(sessionId, admitted.id, run.id, context),
      });
      queueState = enqueued.state;
      const tracked = enqueued.promise.catch(() => {
        // The persisted run state is updated by executeRun or interrupt handling.
      }).finally(() => {
        if (this.runPromises.get(run.id) === tracked) this.runPromises.delete(run.id);
      });
      this.runPromises.set(run.id, tracked);
    }
    return { input: admitted, ...(run ? { run, queue_state: queueState } : {}) };
  }

  private interruptSession(sessionId: string): ReturnType<SessionRunCoordinator["interrupt"]> {
    const before = this.latestEventSeq();
    const result = this.runCoordinator.interrupt(sessionId);
    if (result.interrupted) {
      for (const runId of result.queuedRunIds) {
        this.store.updateRun(runId, { status: "interrupted", error: "Queued run interrupted" });
      }
      this.store.appendEvent({
        type: "session.run.interrupt_requested",
        sessionId,
        payload: { runId: result.activeRunId, queuedRunIds: result.queuedRunIds },
      });
      this.broadcastSince(before);
    }
    return result;
  }

  private hasAnyActiveRuns(): boolean {
    return this.store.listSessions({ includeArchived: true }).some((session) => this.runCoordinator.hasWork(session.id));
  }

  private hasActiveRunsForCwd(cwd: string): boolean {
    return this.store.listSessions({ cwd, includeArchived: true }).some((session) => this.runCoordinator.hasWork(session.id));
  }

  private async executeRun(
    sessionId: string,
    inputId: string,
    runId: string,
    context: { signal: AbortSignal; wakeCount(): number },
  ): Promise<void> {
    if (!this.runtimeFactory) return;
    let before = this.latestEventSeq();
    try {
      const session = this.store.getSession(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      const history = this.store.listMessages(sessionId);
      const parts = this.store.listMessageParts(sessionId);
      const admitted = this.store.getInput(inputId);
      if (!admitted) throw new Error(`Session input not found: ${inputId}`);
      const traceId = this.traceIdForRun(runId);

      this.store.updateRun(runId, { status: "running" });
      this.log({ level: "info", event: "session.run.started", traceId, sessionId, runId });
      const renderState = this.createRunRenderState(sessionId, inputId, runId, admitted.content);
      this.broadcastSince(before);

      const drainSteeredInputs = () => {
        const pending = this.store.listUnboundInputs(sessionId);
        if (pending.length === 0) return pending;
        const eventBefore = this.latestEventSeq();
        this.completeActiveTextPart(renderState, "completed");
        delete renderState.assistantMessageId;
        renderState.assistantTurnCompleted = true;
        for (const steered of pending) {
          const userMessage = this.store.createMessage({
            sessionId,
            role: "user",
            runId,
            inputId: steered.id,
          });
          this.store.upsertMessagePart({
            sessionId,
            messageId: userMessage.id,
            type: "text",
            status: "completed",
            text: steered.content,
          });
        }
        this.broadcastSince(eventBefore);
        return pending;
      };

      const runtime = await this.getOrCreateRuntime(session, history, parts);
      await runtime.runPrompt(
        {
          session,
          input: admitted,
          runId,
          history,
          parts,
          signal: context.signal,
          wakeCount: context.wakeCount,
          drainSteeredInputs,
        },
        {
          onEvent: (event) => {
            const eventBefore = this.latestEventSeq();
            this.store.appendEvent({
              type: event.type,
              sessionId,
              payload: event.payload,
            });
            this.broadcastSince(eventBefore);
          },
          onStreamEvent: (event) => {
            const canDirectBroadcast = event.type === "text_delta" && Boolean(renderState.activeTextPartId);
            const eventBefore = canDirectBroadcast ? undefined : this.latestEventSeq();
            const completedToolName = event.type === "tool_use_end"
              ? renderState.toolParts.get(event.toolUseId)?.toolName
              : undefined;
            const liveEvent = this.applyStreamEvent(renderState, event);
            if (event.type === "tool_use_start") {
              this.log({
                level: "info",
                event: "session.tool.started",
                traceId,
                sessionId,
                runId,
                toolName: event.toolUse.name,
              });
            } else if (event.type === "tool_use_end") {
              this.log({
                level: event.result.isError ? "warn" : "info",
                event: "session.tool.completed",
                traceId,
                sessionId,
                runId,
                toolName: completedToolName,
                ...(event.result.isError ? { error: "tool returned an error" } : {}),
              });
            }
            if (canDirectBroadcast && liveEvent) {
              this.broadcastEvent(liveEvent);
            } else if (eventBefore !== undefined) {
              this.broadcastSince(eventBefore);
            }
          },
          askPermission: (request) =>
            this.permissionBroker.ask({
              sessionId,
              runId,
              traceId,
              toolName: request.toolName,
              reason: request.reason,
              input: request.input,
              signal: context.signal,
            }),
        },
      );

      before = this.latestEventSeq();
      this.completeActiveTextPart(renderState, "completed");
      this.store.updateRun(runId, { status: context.signal.aborted ? "interrupted" : "completed" });
      this.log({
        level: context.signal.aborted ? "warn" : "info",
        event: context.signal.aborted ? "session.run.interrupted" : "session.run.completed",
        traceId,
        sessionId,
        runId,
      });
      this.broadcastSince(before);
    } catch (error) {
      await this.closeRuntime(sessionId);
      before = this.latestEventSeq();
      const message = error instanceof Error ? error.message : String(error);
      const traceId = this.traceIdForRun(runId);
      if (error instanceof RunInterruptedError || context.signal.aborted) {
        this.store.appendEvent({ type: "session.run.interrupted", sessionId, payload: { runId, traceId, error: message } });
        this.store.updateRun(runId, { status: "interrupted", error: message });
        this.log({ level: "warn", event: "session.run.interrupted", traceId, sessionId, runId, error: message });
      } else {
        this.store.appendEvent({ type: "session.run.error", sessionId, payload: { runId, traceId, error: message } });
        this.store.updateRun(runId, { status: "failed", error: message });
        this.log({ level: "error", event: "session.run.failed", traceId, sessionId, runId, error: message });
      }
      this.broadcastSince(before);
    }
  }

  private createRunRenderState(
    sessionId: string,
    inputId: string,
    runId: string,
    content: string,
  ): ActiveRunRenderState {
    const userMessage = this.store.createMessage({
      sessionId,
      role: "user",
      runId,
      inputId,
    });
    this.store.upsertMessagePart({
      sessionId,
      messageId: userMessage.id,
      type: "text",
      status: "completed",
      text: content,
    });
    return {
      sessionId,
      runId,
      inputId,
      assistantTurnCompleted: false,
      toolParts: new Map(),
    };
  }

  private applyStreamEvent(state: ActiveRunRenderState, event: StreamEvent): SessionEventRecord | undefined {
    switch (event.type) {
      case "text_delta": {
        const messageId = this.ensureAssistantMessage(state, true);
        if (!state.activeTextPartId) {
          const part = this.store.upsertMessagePart({
            sessionId: state.sessionId,
            messageId,
            type: "text",
            status: "running",
            text: "",
          });
          state.activeTextPartId = part.id;
        }
        return this.store.appendMessagePartDelta({
          sessionId: state.sessionId,
          messageId,
          partId: state.activeTextPartId,
          field: "text",
          delta: event.delta,
        });
      }
      case "tool_use_start": {
        this.completeActiveTextPart(state, "completed");
        const messageId = this.ensureAssistantMessage(state, true);
        const part = this.store.upsertMessagePart({
          id: event.toolUse.id,
          sessionId: state.sessionId,
          messageId,
          type: "tool",
          status: "running",
          toolUseId: event.toolUse.id,
          toolName: event.toolUse.name,
          input: event.toolUse.input,
        });
        state.toolParts.set(event.toolUse.id, {
          partId: part.id,
          messageId,
          toolName: event.toolUse.name,
          input: event.toolUse.input,
        });
        break;
      }
      case "tool_use_end": {
        const active = state.toolParts.get(event.toolUseId);
        const messageId = active?.messageId ?? this.ensureAssistantMessage(state);
        this.store.upsertMessagePart({
          id: active?.partId ?? event.toolUseId,
          sessionId: state.sessionId,
          messageId,
          type: "tool",
          status: event.result.isError ? "failed" : "completed",
          toolUseId: event.toolUseId,
          ...(active?.toolName ? { toolName: active.toolName } : {}),
          ...(active?.input ? { input: active.input } : {}),
          output: event.result,
          isError: event.result.isError === true,
        });
        state.toolParts.delete(event.toolUseId);
        break;
      }
      case "usage": {
        this.store.updateRun(state.runId, { metadata: { usage: event.usage } });
        break;
      }
      case "complete": {
        this.completeActiveTextPart(state, "completed");
        state.assistantTurnCompleted = true;
        this.store.updateRun(state.runId, { metadata: { stopReason: event.stopReason } });
        break;
      }
      case "error": {
        const messageId = this.ensureAssistantMessage(state, true);
        this.completeActiveTextPart(state, "failed");
        this.store.upsertMessagePart({
          sessionId: state.sessionId,
          messageId,
          type: "error",
          status: "failed",
          text: event.error.message,
        });
        break;
      }
    }
  }

  private ensureAssistantMessage(state: ActiveRunRenderState, startTurn = false): string {
    if (startTurn && state.assistantTurnCompleted) {
      delete state.assistantMessageId;
      state.assistantTurnCompleted = false;
    }
    if (state.assistantMessageId) return state.assistantMessageId;
    const message = this.store.createMessage({
      sessionId: state.sessionId,
      role: "assistant",
      runId: state.runId,
    });
    state.assistantMessageId = message.id;
    return message.id;
  }

  private completeActiveTextPart(
    state: ActiveRunRenderState,
    status: "completed" | "failed" | "interrupted",
  ): void {
    if (!state.assistantMessageId || !state.activeTextPartId) return;
    this.store.upsertMessagePart({
      id: state.activeTextPartId,
      sessionId: state.sessionId,
      messageId: state.assistantMessageId,
      type: "text",
      status,
    });
    delete state.activeTextPartId;
  }

  private async getOrCreateRuntime(
    session: Parameters<SessionRuntimeFactory["createRuntime"]>[0]["session"],
    history: Parameters<SessionRuntimeFactory["createRuntime"]>[0]["history"],
    parts: Parameters<SessionRuntimeFactory["createRuntime"]>[0]["parts"],
  ): Promise<SessionRuntime> {
    if (!this.runtimeFactory) throw new Error("Runtime factory is not configured");
    const existing = this.runtimes.get(session.id);
    if (existing) return await existing;

    const promise = this.runtimeFactory.createRuntime({
      session,
      history,
      parts,
      childSessionHost: this.childSessionHost,
      sessionTaskBridge: this.createSessionTaskBridge(session),
    }).catch((error) => {
      if (this.runtimes.get(session.id) === promise) this.runtimes.delete(session.id);
      throw error;
    });
    this.runtimes.set(session.id, promise);
    return await promise;
  }

  private createSessionTaskBridge(session: { id: string; cwd: string }): SessionTaskBridge {
    const manager = getTaskManager({ cwd: session.cwd, sessionId: session.id });
    return {
      registerSessionTask: (input) => {
        const task = manager.registerSessionTask({ ...input, id: `task_${randomUUID()}` });
        const before = this.latestEventSeq();
        this.store.createSessionTask({
          id: task.id,
          sessionId: input.sessionId,
          childSessionId: input.childSessionId,
          type: task.type,
          description: task.description,
          cwd: task.cwd,
          metadata: { origin: "child_session", agent: task.description, taskManagerId: task.id },
        });
        this.log({
          level: "info",
          event: "session.task.created",
          sessionId: input.sessionId,
          taskId: task.id,
        });
        this.broadcastSince(before);
        return { id: task.id };
      },
      bindSessionTaskRun: async (taskId, runId) => {
        const before = this.latestEventSeq();
        const task = this.store.updateSessionTask(taskId, { status: "running", runId });
        this.log({
          level: "info",
          event: "session.task.bound",
          traceId: this.traceIdForRun(runId),
          sessionId: task.sessionId,
          runId,
          taskId,
        });
        this.broadcastSince(before);
      },
      completeSessionTask: async (taskId, input) => {
        const managerStatus = input.status === "interrupted" ? "stopped" : input.status;
        const task = await manager.completeSessionTask(taskId, { ...input, status: managerStatus });
        const before = this.latestEventSeq();
        this.store.updateSessionTask(taskId, {
          status: input.status,
          output: input.output,
          ...(input.status === "failed" ? { error: input.output } : {}),
        });
        const persisted = this.store.getSessionTask(taskId);
        this.log({
          level: input.status === "failed" ? "error" : "info",
          event: "session.task.completed",
          ...(persisted?.runId ? { traceId: this.traceIdForRun(persisted.runId), runId: persisted.runId } : {}),
          sessionId: persisted?.sessionId ?? session.id,
          taskId,
          ...(input.status === "failed" ? { error: "task failed" } : {}),
        });
        this.broadcastSince(before);
        return task;
      },
      writeToSessionTask: async (taskId, data) => {
        await manager.writeToTask(taskId, data);
        const before = this.latestEventSeq();
        this.store.updateSessionTask(taskId, { status: "running" });
        this.broadcastSince(before);
      },
    };
  }

  private projectManagerTasks(sessionId: string, manager: ReturnType<typeof getTaskManager>): void {
    for (const task of manager.listTasks()) {
      const persisted = this.store.findSessionTaskByManagerTaskId(sessionId, task.id);
      if (!persisted) {
        const sameId = this.store.getSessionTask(task.id);
        this.store.createSessionTask({
          id: sameId && sameId.sessionId !== sessionId ? `task_${randomUUID()}` : task.id,
          sessionId,
          childSessionId: typeof task.metadata.child_session_id === "string" ? task.metadata.child_session_id : undefined,
          type: task.type,
          description: task.description,
          cwd: task.cwd,
          metadata: { origin: "task_manager", taskManagerId: task.id },
        });
      }
      const durableTask = this.store.findSessionTaskByManagerTaskId(sessionId, task.id) ?? this.store.getSessionTask(task.id);
      if (durableTask?.sessionId === sessionId) this.syncPersistentTask(task, manager, durableTask.id);
    }
  }

  private trackTask(manager: ReturnType<typeof getTaskManager>, taskId: string): void {
    manager.registerTaskListener((task) => {
      if (task.id !== taskId) return;
      const persisted = this.store.getSessionTask(taskId);
      if (!persisted) return;
      this.syncPersistentTask(task, manager, persisted.id);
    });
  }

  private syncPersistentTask(
    task: TaskInfo,
    manager: ReturnType<typeof getTaskManager>,
    durableTaskId = task.id,
  ): void {
    const status = task.status === "pending" || task.status === "running" || task.status === "completed" ||
      task.status === "failed" || task.status === "stopped" ? task.status : "failed";
    let output: string | undefined;
    try { output = manager.readTaskOutput(task.id); } catch { /* output is optional */ }
    const before = this.latestEventSeq();
    this.store.updateSessionTask(durableTaskId, {
      status,
      ...(output !== undefined ? { output } : {}),
      ...(status === "failed" ? { error: output ?? "Task failed" } : {}),
    });
    this.broadcastSince(before);
  }

  private async warmRuntime(sessionId: string): Promise<void> {
    if (!this.runtimeFactory || this.runtimes.has(sessionId)) return;
    const session = this.store.getSession(sessionId);
    if (!session || session.status === "archived") return;
    const history = this.store.listMessages(sessionId);
    const parts = this.store.listMessageParts(sessionId);
    await this.getOrCreateRuntime(session, history, parts).catch(() => {});
  }

  private async closeRuntime(sessionId: string): Promise<void> {
    const runtimePromise = this.runtimes.get(sessionId);
    if (!runtimePromise) return;
    this.runtimes.delete(sessionId);
    try {
      const runtime = await runtimePromise;
      await runtime.close();
    } catch {
      // Runtime may have failed while being created; nothing else to close.
    }
  }

  private async closeAllRuntimes(): Promise<void> {
    const sessionIds = [...this.runtimes.keys()];
    await Promise.all(sessionIds.map((sessionId) => this.closeRuntime(sessionId)));
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
