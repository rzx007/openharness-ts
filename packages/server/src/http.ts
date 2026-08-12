import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";

import { SessionStore } from "@openharness/services";
import type { Settings } from "@openharness/core";

import type { CommandCatalogProvider } from "./commands.js";
import { DaemonApplication } from "./daemon-application.js";
import type { CreateDaemonAgent } from "./daemon-agent.js";
import { getDefaultSessionStorePath } from "./paths.js";
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
  errorResponse,
  normalizeAllowedOrigins,
  type JsonRecord,
} from "./http/support.js";
import { createAuthRoutes } from "./http/routes/auth.js";
import { createCronRoutes } from "./http/routes/cron.js";
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
import { RequestTraceRegistry } from "./http/request-trace-registry.js";

export interface OpenHarnessServerServices {
  commandCatalog?: CommandCatalogProvider;
  settings?: SettingsService;
  provider?: ProviderService;
  memory?: MemoryService;
  auth?: AuthService;
  context?: ContextService;
  dream?: DreamService;
  profile?: ProfileService;
  outputStyle?: OutputStyleService;
  projectInit?: ProjectInitService;
  plugin?: PluginService;
  agentPersona?: AgentPersonaService;
  hooks?: HooksService;
  git?: GitService;
}

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
  getSettingsForCwd?: (cwd: string) => Promise<Settings>;
  /** Test/embedding seam. Production daemon creation uses createOpenHarnessAgent directly. */
  createAgent?: CreateDaemonAgent;
  services?: OpenHarnessServerServices;
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
  private readonly services: OpenHarnessServerServices;
  private readonly version?: string;
  private readonly logger: StructuredLogger;
  private readonly eventHub: HttpEventHub;
  private readonly daemon: DaemonApplication;
  private readonly requestTraces = new RequestTraceRegistry();
  private listener?: Listener;
  private listenResult?: ListenResult;
  private closePromise?: Promise<void>;

  constructor(options: OpenHarnessServerOptions = {}) {
    this.app = new Hono();
    this.store = options.store ?? new SessionStore({ path: options.storePath ?? getDefaultSessionStorePath() });
    this.token = options.token;
    this.allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins ?? []);
    this.services = options.services ?? {};
    this.version = options.version;
    this.logger = options.logger ?? writeStructuredLog;
    this.eventHub = new HttpEventHub(this.store);
    this.daemon = new DaemonApplication({
      store: this.store,
      eventSink: this.eventHub,
      settings: options.settings,
      getSettings: options.getSettings,
      getSettingsForCwd: options.getSettingsForCwd,
      createAgent: options.createAgent,
      sseClientCount: () => this.eventHub.clientCount,
      log: (event) => this.log(event),
    });
    this.mountRoutes();
  }

  get url(): string | undefined {
    return this.listenResult?.url;
  }

  async listen(options: Pick<OpenHarnessServerOptions, "host" | "port"> = {}): Promise<ListenResult> {
    await this.daemon.ready();
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

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const closing = this.closeWork();
    this.closePromise = closing;
    return closing;
  }

  private async closeWork(): Promise<void> {
    const shutdown = this.daemon.shutdown();
    const failures: unknown[] = [];
    try {
      this.eventHub.closeClients();
    } catch (error) {
      failures.push(error);
    }
    const listener = this.listener;
    this.listener = undefined;
    const listenerClosed = listener
      ? new Promise<void>((resolve, reject) => {
          listener.close((error?: Error) => {
            if (error) reject(error);
            else resolve();
          });
        })
      : Promise.resolve();
    const settled = await Promise.allSettled([shutdown, listenerClosed]);
    for (const result of settled) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    try {
      this.store.close();
    } catch (error) {
      failures.push(error);
    }
    throwFailures(failures, "OpenHarness server shutdown failed");
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
      commandCatalog: this.services.commandCatalog,
      settingsService: this.services.settings,
      providerService: this.services.provider,
      control: this.daemon.control,
    }));
    this.app.route("/memory", createMemoryRoutes({
      memoryService: this.services.memory,
      control: this.daemon.control,
    }));
    this.app.route("/auth", createAuthRoutes({
      authService: this.services.auth,
      control: this.daemon.control,
    }));
    this.app.route("/", createServiceRoutes({
      contextService: this.services.context,
      dreamService: this.services.dream,
      profileService: this.services.profile,
      outputStyleService: this.services.outputStyle,
      projectInitService: this.services.projectInit,
      pluginService: this.services.plugin,
      agentPersonaService: this.services.agentPersona,
      hooksService: this.services.hooks,
      control: this.daemon.control,
    }));
    this.app.route("/git", createGitRoutes({ gitService: this.services.git }));
    this.app.route("/cron", createCronRoutes({ cron: this.daemon.cron }));
    this.app.route("/tasks", createTaskRoutes({
      tasks: this.daemon.tasks,
    }));
    this.app.route("/permissions", createPermissionRoutes({
      permissions: this.daemon.permissions,
      traces: this.requestTraces,
    }));
    this.app.route("/sessions", createSessionUtilityRoutes({
      maintenance: this.daemon.maintenance,
    }));
    this.app.route("/sessions", createSessionRoutes({
      queries: this.daemon.queries,
      application: this.daemon.sessions,
      commandCatalog: this.services.commandCatalog,
      traces: this.requestTraces,
    }));
    this.app.route("/sessions", createRunExecutionRoutes({
      application: this.daemon.sessions,
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
}

export async function startOpenHarnessServer(options: OpenHarnessServerOptions = {}): Promise<{
  server: OpenHarnessHttpServer;
  listen: ListenResult;
}> {
  const server = new OpenHarnessHttpServer(options);
  try {
    const listen = await server.listen(options);
    return { server, listen };
  } catch (error) {
    try {
      await server.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "OpenHarness server startup and cleanup failed");
    }
    throw error;
  }
}

function throwFailures(failures: unknown[], message: string): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}
