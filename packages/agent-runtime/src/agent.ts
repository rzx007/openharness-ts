import { randomUUID } from "node:crypto";

import type {
  AgentChildDirectory,
  AgentEffects,
  AgentEventListener,
  AgentEventSubscription,
  AgentRunHandle,
  AgentRunResult,
  AgentScheduleEffects,
  AgentSession,
  ContentBlock,
  HookDefinition,
  Message,
  RuntimeBundle,
  Settings,
  UsageSnapshot,
} from "@openharness/core";
import type { McpClientManager, McpConnection } from "@openharness/mcp";

import {
  composeOpenHarnessAgent,
  type AgentIdentity,
} from "./agent-composition.js";
import {
  AgentOperationConflictError,
  type OpenHarnessAgentState,
} from "./agent-errors.js";
import type { OpenHarnessAgentConfiguration } from "./agent-options.js";
import {
  AgentChildRegistry,
  type AgentChildEnvironmentProvider,
  type AgentChildManager,
} from "./child-agent.js";
import { AgentEventBus } from "./event-source.js";
import type { OpenHarnessAgentExtension } from "./extensions.js";
import { FrameworkAgentRun } from "./framework-agent-run.js";
import type {
  AgentMemoryRuntime,
  AgentRememberResult,
} from "./memory-runtime.js";

export {
  AgentOperationConflictError,
  type OpenHarnessAgentState,
} from "./agent-errors.js";

export interface OpenHarnessAgentOptions extends OpenHarnessAgentConfiguration {
  settings?: Settings;
  cwd?: string;
  sessionId?: string;
  mcpServers?: Settings["mcpServers"];
  extensions?: OpenHarnessAgentExtension[];
  childIdleTtlMs?: number;
  requestPermission?: AgentEffects["requestPermission"];
  /** Host-owned Agent scheduled tasks. Omit when the host has no durable scheduler. */
  schedules?: AgentScheduleEffects;
  /** Reliable ordered host sink. A rejection fails the active framework operation. */
  onEvent?: AgentEventListener;
  childEnvironment?: AgentChildEnvironmentProvider;
}

export interface OpenHarnessAgentSubmitOptions {
  signal?: AbortSignal;
  delivery?: "queue" | "steer";
  metadata?: Record<string, unknown>;
  ids?: {
    inputId: string;
    runId: string;
    traceId: string;
  };
}

interface InternalAgentOptions {
  eventBus: AgentEventBus;
  effects: AgentEffects;
  childDirectory: AgentChildRegistry;
  identity?: AgentIdentity;
}

export interface AgentCompactResult {
  history: Message[];
  beforeMessageCount: number;
  afterMessageCount: number;
}

export interface AgentInspection {
  model: string;
  tools: Array<{ name: string }>;
  hooks: Array<Pick<HookDefinition, "id" | "event" | "type" | "enabled">>;
  mcpServers: Array<{
    name: string;
    status: string;
    toolCount: number;
    resourceCount: number;
    command?: string;
    error?: string;
  }>;
  sandbox?: NonNullable<RuntimeBundle["sandboxStatus"]>;
}

export interface OpenHarnessAgent {
  readonly id: string;
  readonly state: OpenHarnessAgentState;
  readonly children: AgentChildDirectory;
  /** Subscribe to ordered observations. Observer failures never fail agent execution. */
  subscribe(listener: AgentEventListener): AgentEventSubscription;
  submitMessage(
    content: string | ContentBlock[],
    options?: OpenHarnessAgentSubmitOptions,
  ): AgentRunHandle;
  runMessage(
    content: string | ContentBlock[],
    options?: OpenHarnessAgentSubmitOptions,
  ): Promise<AgentRunResult>;
  getHistory(): Message[];
  loadHistory(messages: Message[]): void;
  clear(): void;
  setModel(model: string): void;
  compact(): Promise<AgentCompactResult>;
  remember(): Promise<AgentRememberResult>;
  getUsage(): UsageSnapshot;
  inspect(): AgentInspection;
  close(): Promise<void>;
}

class DefaultOpenHarnessAgent implements OpenHarnessAgent {
  private activeRun?: FrameworkAgentRun;
  private maintenance?: {
    kind: "compact" | "remember";
    settled: Promise<void>;
  };
  private lifecycleState: OpenHarnessAgentState = "idle";
  private closePromise?: Promise<void>;

  constructor(
    private readonly runtime: RuntimeBundle,
    private readonly session: AgentSession,
    private readonly mcpManager: McpClientManager,
    private readonly memory: AgentMemoryRuntime | undefined,
    private readonly eventBus: AgentEventBus,
    private readonly effects: AgentEffects,
    private readonly identity: AgentIdentity | undefined,
    private readonly childManager: AgentChildManager,
    readonly children: AgentChildDirectory,
    private model: string,
  ) {}

  get id(): string {
    return this.session.id;
  }

  get state(): OpenHarnessAgentState {
    return this.lifecycleState;
  }

  subscribe(listener: AgentEventListener): AgentEventSubscription {
    return this.eventBus.subscribe(listener);
  }

  submitMessage(
    content: string | ContentBlock[],
    options: OpenHarnessAgentSubmitOptions = {},
  ): AgentRunHandle {
    this.assertIdle("submit a message");
    const ids = options.ids ?? {
      inputId: `input_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      traceId: randomUUID(),
    };
    const run = new FrameworkAgentRun({
      agentId: this.id,
      session: this.session,
      runtime: this.runtime,
      eventBus: this.eventBus,
      effects: this.effects,
      children: this.childManager,
      identity: this.identity,
      content,
      ids,
      externalSignal: options.signal,
      delivery: options.delivery ?? "queue",
      metadata: options.metadata,
      onSettled: () => {
        if (this.activeRun !== run) return;
        this.activeRun = undefined;
        if (this.lifecycleState === "running") this.lifecycleState = "idle";
      },
    });
    this.activeRun = run;
    this.lifecycleState = "running";
    return run;
  }

  async runMessage(
    content: string | ContentBlock[],
    options: OpenHarnessAgentSubmitOptions = {},
  ): Promise<AgentRunResult> {
    return await this.submitMessage(content, options).result;
  }

  getHistory(): Message[] {
    return this.session.getHistory();
  }

  loadHistory(messages: Message[]): void {
    this.assertIdle("load history");
    this.runtime.queryEngine.loadMessages(messages);
  }

  clear(): void {
    this.assertIdle("clear history");
    this.session.clear();
  }

  setModel(model: string): void {
    this.assertIdle("set the model");
    this.model = model;
    this.runtime.queryEngine.setModel(model);
  }

  compact(): Promise<AgentCompactResult> {
    return this.runMaintenance("compact", async () => {
      const beforeMessageCount = this.getHistory().length;
      await this.runtime.queryEngine.compact();
      const history = this.getHistory();
      return { history, beforeMessageCount, afterMessageCount: history.length };
    });
  }

  remember(): Promise<AgentRememberResult> {
    return this.runMaintenance("remember", async () => {
      if (!this.memory) {
        return {
          skipped: true,
          reason: "memory is disabled",
          writtenIds: [],
          titles: [],
        };
      }
      return await this.memory.remember(
        this.getHistory(),
        this.runtime.apiClient,
        this.model,
      );
    });
  }

  getUsage(): UsageSnapshot {
    return this.runtime.queryEngine.getTotalUsage();
  }

  inspect(): AgentInspection {
    return {
      model: this.model,
      tools: this.runtime.toolRegistry
        .getAll()
        .map((tool) => ({ name: tool.name })),
      hooks: (this.runtime.hookExecutor.getAll?.() ?? []).map((hook) => ({
        id: hook.id,
        event: hook.event,
        type: hook.type,
        enabled: hook.enabled,
      })),
      mcpServers: this.mcpManager.getConnections().map(toMcpInspection),
      ...(this.runtime.sandboxStatus
        ? { sandbox: this.runtime.sandboxStatus }
        : {}),
    };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.lifecycleState === "closed") return Promise.resolve();
    this.lifecycleState = "closing";
    const closing = (async () => {
      const failures: unknown[] = [];
      try {
        for (const cleanup of [
          () => this.activeRun?.interrupt("Agent closed") ?? Promise.resolve(),
          () => this.maintenance?.settled ?? Promise.resolve(),
          () => this.childManager.closeAll(),
          () => this.eventBus.drain(),
          () => this.runtime.close(),
        ]) {
          try {
            await cleanup();
          } catch (error) {
            failures.push(error);
          }
        }
      } finally {
        this.lifecycleState = "closed";
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, `Agent cleanup failed: ${this.id}`);
    })();
    this.closePromise = closing;
    return closing;
  }

  private assertIdle(operation: string): void {
    if (this.lifecycleState !== "idle") {
      throw new AgentOperationConflictError(
        this.id,
        this.lifecycleState,
        operation,
      );
    }
  }

  private runMaintenance<T>(
    kind: "compact" | "remember",
    work: () => Promise<T>,
  ): Promise<T> {
    this.assertIdle(kind);
    this.lifecycleState = "maintaining";
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const operation = { kind, settled };
    this.maintenance = operation;
    return (async () => {
      try {
        return await work();
      } finally {
        if (this.maintenance === operation) this.maintenance = undefined;
        if (this.lifecycleState === "maintaining") this.lifecycleState = "idle";
        settle();
      }
    })();
  }
}

export async function createOpenHarnessAgent(
  options: OpenHarnessAgentOptions = {},
): Promise<OpenHarnessAgent> {
  const eventBus = new AgentEventBus(options.onEvent);
  const effects: AgentEffects = {
    requestPermission:
      options.requestPermission ??
      (async () => ({
        status: "denied",
        reason: "No permission effect configured",
      })),
    ...(options.schedules ? { schedules: options.schedules } : {}),
  };
  return await createOpenHarnessAgentInternal(options, {
    eventBus,
    effects,
    childDirectory: new AgentChildRegistry(),
  });
}

async function createOpenHarnessAgentInternal(
  options: OpenHarnessAgentOptions,
  internal: InternalAgentOptions,
): Promise<OpenHarnessAgent> {
  const composition = await composeOpenHarnessAgent(options, {
    ...internal,
    createAgent: (childOptions, identity) =>
      createOpenHarnessAgentInternal(childOptions, {
        eventBus: internal.eventBus,
        effects: internal.effects,
        childDirectory: internal.childDirectory,
        identity,
      }),
  });
  return new DefaultOpenHarnessAgent(
    composition.runtime,
    composition.session,
    composition.mcpManager,
    composition.memory,
    internal.eventBus,
    internal.effects,
    internal.identity,
    composition.childManager,
    internal.childDirectory,
    composition.model,
  );
}

function toMcpInspection(
  connection: McpConnection,
): AgentInspection["mcpServers"][number] {
  return {
    name: connection.name,
    status: connection.status,
    toolCount: connection.tools.length,
    resourceCount: connection.resources.length,
    command: connection.config.command
      ? `${connection.config.command} ${(connection.config.args ?? []).join(" ")}`.trim()
      : connection.config.url,
    ...(connection.error ? { error: connection.error.message } : {}),
  };
}
