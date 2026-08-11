import { randomUUID } from "node:crypto";

import type {
  AgentChildDirectory,
  AgentEffects,
  AgentEventContext,
  AgentEventInput,
  AgentEventSource,
  AgentExecutionContext,
  AgentInputReceipt,
  AgentRunHandle,
  AgentRunResult,
  AgentRunScope,
  AgentSerializedError,
  AgentSteerInput,
  ContentBlock,
  HookDefinition,
  Message,
  Settings,
  StreamEvent,
  UsageSnapshot,
} from "@openharness/core";
import {
  AgentRunNotAcceptingInputError,
  createAgentSession,
  loadSettings,
  type AgentSession,
  type RuntimeBundle,
} from "@openharness/core";
import { McpClientManager, type McpConnection } from "@openharness/mcp";

import {
  createOpenHarnessRuntime,
  type OpenHarnessRuntimeOverrides,
} from "./default-runtime.js";
import {
  configureDiscoveredExtensions,
  discoverOpenHarnessExtensions,
  type OpenHarnessAgentExtension,
} from "./extensions.js";
import {
  createAgentMemoryRuntime,
  type AgentMemoryRuntime,
  type AgentRememberResult,
} from "./memory-runtime.js";
import {
  AgentChildRegistry,
  AgentChildManager,
  type AgentChildEnvironmentProvider,
} from "./child-agent.js";
import { AgentEventBus, AgentEventDeliveryError } from "./event-source.js";

export interface OpenHarnessAgentOptions {
  settings?: Settings;
  cwd?: string;
  sessionId?: string;
  overrides?: OpenHarnessRuntimeOverrides;
  mcpServers?: Settings["mcpServers"];
  extensions?: OpenHarnessAgentExtension[];
  childIdleTtlMs?: number;
  effects?: Partial<AgentEffects>;
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

interface AgentIdentity {
  childId?: string;
  parentSessionId?: string;
  parentRunId?: string;
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
  readonly events: AgentEventSource;
  readonly children: AgentChildDirectory;
  submitMessage(content: string | ContentBlock[], options?: OpenHarnessAgentSubmitOptions): AgentRunHandle;
  runMessage(content: string | ContentBlock[], options?: OpenHarnessAgentSubmitOptions): Promise<AgentRunResult>;
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
  private closed = false;

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

  get events(): AgentEventSource {
    return this.eventBus;
  }

  submitMessage(
    content: string | ContentBlock[],
    options: OpenHarnessAgentSubmitOptions = {},
  ): AgentRunHandle {
    if (this.closed) throw new Error(`Agent is closed: ${this.id}`);
    if (this.activeRun?.active) throw new Error(`Agent already has an active run: ${this.id}`);
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
        if (this.activeRun === run) this.activeRun = undefined;
      },
    });
    this.activeRun = run;
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
    this.runtime.queryEngine.loadMessages(messages);
  }

  clear(): void {
    this.session.clear();
  }

  setModel(model: string): void {
    this.model = model;
    this.runtime.queryEngine.setModel(model);
  }

  async compact(): Promise<AgentCompactResult> {
    const beforeMessageCount = this.getHistory().length;
    await this.runtime.queryEngine.compact();
    const history = this.getHistory();
    return { history, beforeMessageCount, afterMessageCount: history.length };
  }

  async remember(): Promise<AgentRememberResult> {
    if (!this.memory) {
      return { skipped: true, reason: "memory is disabled", writtenIds: [], titles: [] };
    }
    return await this.memory.remember(this.getHistory(), this.runtime.apiClient, this.model);
  }

  getUsage(): UsageSnapshot {
    return this.runtime.queryEngine.getTotalUsage();
  }

  inspect(): AgentInspection {
    return {
      model: this.model,
      tools: this.runtime.toolRegistry.getAll().map((tool) => ({ name: tool.name })),
      hooks: (this.runtime.hookExecutor.getAll?.() ?? []).map((hook) => ({
        id: hook.id,
        event: hook.event,
        type: hook.type,
        enabled: hook.enabled,
      })),
      mcpServers: this.mcpManager.getConnections().map(toMcpInspection),
      ...(this.runtime.sandboxStatus ? { sandbox: this.runtime.sandboxStatus } : {}),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.activeRun?.interrupt("Agent closed");
    await this.childManager.closeAll();
    await this.eventBus.drain();
    await this.runtime.close();
  }
}

interface FrameworkAgentRunOptions {
  agentId: string;
  session: AgentSession;
  runtime: RuntimeBundle;
  eventBus: AgentEventBus;
  effects: AgentEffects;
  children: AgentChildManager;
  identity?: AgentIdentity;
  content: string | ContentBlock[];
  ids: { inputId: string; runId: string; traceId: string };
  externalSignal?: AbortSignal;
  delivery: "queue" | "steer";
  metadata?: Record<string, unknown>;
  onSettled(): void;
}

interface PendingSteer {
  input: AgentSteerInput;
  receipt: ReturnType<typeof deferred<AgentInputReceipt>>;
}

class FrameworkAgentRun implements AgentRunHandle {
  readonly id: string;
  readonly inputId: string;
  readonly sessionId: string;
  readonly traceId: string;
  readonly started: Promise<AgentInputReceipt>;
  readonly result: Promise<AgentRunResult>;
  active = true;

  private readonly controller = new AbortController();
  private readonly steered: PendingSteer[] = [];
  private readonly pendingSteers = new Set<PendingSteer>();
  private readonly start = deferred<AgentInputReceipt>();
  private acceptingInput = true;
  private externalAbort?: () => void;

  constructor(private readonly options: FrameworkAgentRunOptions) {
    this.id = options.ids.runId;
    this.inputId = options.ids.inputId;
    this.sessionId = options.session.id;
    this.traceId = options.ids.traceId;
    this.started = this.start.promise;
    if (options.externalSignal) {
      this.externalAbort = () => this.controller.abort(options.externalSignal!.reason ?? "Run interrupted");
      if (options.externalSignal.aborted) this.externalAbort();
      else options.externalSignal.addEventListener("abort", this.externalAbort, { once: true });
    }
    this.result = Promise.resolve().then(() => this.execute()).finally(() => {
      this.active = false;
      this.acceptingInput = false;
      if (this.externalAbort && options.externalSignal) {
        options.externalSignal.removeEventListener("abort", this.externalAbort);
      }
      options.onSettled();
    });
    void this.started.catch(() => {});
    void this.result.catch(() => {});
  }

  async steer(input: AgentSteerInput): Promise<AgentInputReceipt> {
    if (!this.active || !this.acceptingInput) throw new AgentRunNotAcceptingInputError(this.id);
    const accepted = {
      ...input,
      id: input.id ?? `input_${randomUUID()}`,
      traceId: input.traceId ?? randomUUID(),
      delivery: "steer" as const,
    };
    const receipt = deferred<AgentInputReceipt>();
    void receipt.promise.catch(() => {});
    const pending = { input: accepted, receipt };
    this.steered.push(pending);
    this.pendingSteers.add(pending);
    return await receipt.promise;
  }

  async interrupt(reason?: string): Promise<void> {
    if (!this.controller.signal.aborted) this.controller.abort(reason ?? "Run interrupted");
    await this.result.catch(() => {});
  }

  private async execute(): Promise<AgentRunResult> {
    let output = "";
    let stopReason: string | undefined;
    const scope: AgentRunScope = {
      agentId: this.options.agentId,
      sessionId: this.sessionId,
      inputId: this.inputId,
      runId: this.id,
      cwd: this.options.children.cwd,
      traceId: this.traceId,
      signal: this.controller.signal,
    };
    const execution: AgentExecutionContext = {
      scope,
      effects: this.options.effects,
      children: this.options.children.createController(scope),
      emit: (event) => this.emit(event),
      takeSteeredInputs: (options) => this.takeSteeredInputs(options),
      closeSteering: () => { this.acceptingInput = false; },
    };

    try {
      await this.emit({
        type: "input.accepted",
        data: {
          content: this.options.content,
          delivery: this.options.delivery,
          ...(this.options.metadata ? { metadata: this.options.metadata } : {}),
        },
      });
      await this.emit({ type: "run.started", data: {} });
      this.start.resolve({ sessionId: this.sessionId, inputId: this.inputId, runId: this.id });
      for await (const event of this.options.session.submitMessage(this.options.content, {
        signal: this.controller.signal,
        execution,
      })) {
        if (this.controller.signal.aborted) throw abortError(this.controller.signal);
        if (event.type === "text_delta") output += event.delta;
        if (event.type === "complete") stopReason = event.stopReason;
        await this.projectStreamEvent(event);
      }
      if (this.controller.signal.aborted) throw abortError(this.controller.signal);
      this.acceptingInput = false;
      this.rejectPendingSteers();
      await this.emit({ type: "run.completed", data: { output, ...(stopReason ? { stopReason } : {}) } });
      return {
        status: "completed",
        output,
        history: this.options.session.getHistory(),
        usage: this.options.runtime.queryEngine.getTotalUsage(),
      };
    } catch (error) {
      this.acceptingInput = false;
      this.rejectPendingSteers();
      this.start.reject(error);
      if (!(error instanceof AgentEventDeliveryError)) {
        const interrupted = this.controller.signal.aborted;
        await this.emit({
          type: interrupted ? "run.interrupted" : "run.failed",
          data: { error: serializeError(error), ...(output ? { output } : {}) },
        }).catch(() => {});
      }
      throw error;
    }
  }

  private async takeSteeredInputs(options: { closeIfEmpty?: boolean } = {}): Promise<AgentSteerInput[]> {
    const pending = this.steered.splice(0, 1);
    if (pending.length === 0 && options.closeIfEmpty) this.acceptingInput = false;
    const inputs: AgentSteerInput[] = [];
    try {
      for (const { input } of pending) {
        await this.emit({
          type: "input.accepted",
          data: {
            content: input.content,
            delivery: "steer",
            ...(input.metadata ? { metadata: input.metadata } : {}),
          },
        }, { inputId: input.id, traceId: input.traceId });
        inputs.push(input);
      }
    } catch (error) {
      const rejected = new AgentRunNotAcceptingInputError(this.id);
      for (const item of pending) item.receipt.reject(rejected);
      throw error;
    } finally {
      for (const item of pending) this.pendingSteers.delete(item);
    }
    for (const { input, receipt } of pending) {
      receipt.resolve({ sessionId: this.sessionId, inputId: input.id!, runId: this.id });
    }
    return inputs;
  }

  private rejectPendingSteers(): void {
    const error = new AgentRunNotAcceptingInputError(this.id);
    for (const pending of this.pendingSteers) pending.receipt.reject(error);
    this.pendingSteers.clear();
    this.steered.splice(0);
  }

  private async projectStreamEvent(event: StreamEvent): Promise<void> {
    if (event.type === "text_delta") {
      await this.emit({ type: "output.text.delta", data: { delta: event.delta } });
    } else if (event.type === "complete") {
      await this.emit({ type: "output.turn.completed", data: { stopReason: event.stopReason } });
    } else if (event.type === "tool_use_start") {
      await this.emit({ type: "tool.started", data: { toolUse: event.toolUse } });
    } else if (event.type === "tool_use_end") {
      await this.emit({
        type: "tool.completed",
        data: { toolUseId: event.toolUseId, result: event.result },
      });
    } else if (event.type === "usage") {
      await this.emit({ type: "usage.updated", data: { usage: event.usage } });
    } else if (event.type === "error") {
      throw event.error;
    }
  }

  private async emit(
    event: AgentEventInput,
    override: Partial<AgentEventContext> = {},
  ): Promise<void> {
    await this.options.eventBus.emit(event, {
      agentId: this.options.agentId,
      sessionId: this.sessionId,
      inputId: this.inputId,
      runId: this.id,
      traceId: this.traceId,
      ...this.options.identity,
      ...override,
    });
  }
}

export async function createOpenHarnessAgent(
  options: OpenHarnessAgentOptions = {},
): Promise<OpenHarnessAgent> {
  const eventBus = new AgentEventBus();
  const effects: AgentEffects = {
    requestPermission: options.effects?.requestPermission ?? (async () => ({
      status: "denied",
      reason: "No permission effect configured",
    })),
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
  const cwd = options.cwd ?? process.cwd();
  const settings = options.settings ?? await loadSettings({});
  const discovery = await discoverOpenHarnessExtensions(cwd, settings);
  for (const warning of discovery.warnings) process.stderr.write(`[plugins] ${warning}\n`);
  const runtime = await createOpenHarnessRuntime({
    settings,
    cwd,
    sessionId: options.sessionId,
    overrides: options.overrides,
    skillRegistry: discovery.skillRegistry,
  });
  try {
    await configureDiscoveredExtensions(discovery, runtime);
    for (const extension of options.extensions ?? []) {
      await extension.setup({
        cwd,
        settings,
        skillRegistry: discovery.skillRegistry,
        toolRegistry: runtime.toolRegistry,
        hookExecutor: runtime.hookExecutor,
      });
    }

    const mcpManager = new McpClientManager();
    const mcpServers = options.mcpServers ?? discovery.mcpServers;
    if (Object.keys(mcpServers).length > 0) await mcpManager.connectAll(mcpServers);
    for (const tool of mcpManager.getAsToolDefinitions()) runtime.toolRegistry.register(tool);
    runtime.queryEngine.setMcpManager(mcpManager);
    runtime.addCleanup(() => mcpManager.disconnectAll());

    const memory = settings.memory?.enabled === false
      ? undefined
      : await createAgentMemoryRuntime(cwd, settings.memory?.maxFiles ?? 10);
    runtime.queryEngine.setMemoryRetriever(memory
      ? (userInput) => memory.retrieve(userInput)
      : undefined);

    const session = createAgentSession({ queryEngine: runtime.queryEngine, sessionId: options.sessionId });
    const children = new AgentChildManager({
      settings,
      cwd,
      idleTtlMs: options.childIdleTtlMs,
      eventBus: internal.eventBus,
      directory: internal.childDirectory,
      environment: options.childEnvironment,
      createAgent: (childOptions, identity) => createOpenHarnessAgentInternal(childOptions, {
        eventBus: internal.eventBus,
        effects: internal.effects,
        childDirectory: internal.childDirectory,
        identity,
      }),
    });
    return new DefaultOpenHarnessAgent(
      runtime,
      session,
      mcpManager,
      memory,
      internal.eventBus,
      internal.effects,
      internal.identity,
      children,
      internal.childDirectory,
      options.overrides?.model ?? settings.model,
    );
  } catch (error) {
    await runtime.close();
    throw error;
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "Run interrupted");
}

export function serializeError(error: unknown): AgentSerializedError {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    return {
      name: error.name,
      message: error.message,
      ...(code ? { code } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

function toMcpInspection(connection: McpConnection): AgentInspection["mcpServers"][number] {
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
