import type {
  AgentSessionHostCallbacks,
  AgentSessionRunResult,
  AgentSessionSubmitOptions,
  AgentChildAgentHost,
  AgentRunHost,
  ContentBlock,
  HookDefinition,
  Message,
  Settings,
  UsageSnapshot,
} from "@openharness/core";
import { createAgentSession, loadSettings, type AgentSession, type RuntimeBundle } from "@openharness/core";
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
import { AgentChildManager, type AgentChildProjection } from "./child-agent.js";

export interface OpenHarnessAgentOptions
  extends AgentSessionHostCallbacks {
  settings?: Settings;
  cwd?: string;
  sessionId?: string;
  overrides?: OpenHarnessRuntimeOverrides;
  mcpServers?: Settings["mcpServers"];
  extensions?: OpenHarnessAgentExtension[];
  childIdleTtlMs?: number;
}

export interface OpenHarnessAgentSubmitOptions extends AgentSessionSubmitOptions {
  childProjection?: AgentChildProjection;
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
  submitMessage(content: string | ContentBlock[], options?: OpenHarnessAgentSubmitOptions): AsyncIterable<import("@openharness/core").StreamEvent>;
  runMessage(content: string | ContentBlock[], options?: OpenHarnessAgentSubmitOptions): Promise<AgentSessionRunResult>;
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
  constructor(
    private readonly runtime: RuntimeBundle,
    private readonly session: AgentSession,
    private readonly mcpManager: McpClientManager,
    private readonly memory: AgentMemoryRuntime | undefined,
    private readonly children: AgentChildManager,
    private model: string,
  ) {}

  get id(): string {
    return this.session.id;
  }

  submitMessage(content: string | ContentBlock[], options: OpenHarnessAgentSubmitOptions = {}) {
    const baseHost = options.host ?? this.session.createHost(options.signal);
    const host = composeAgentRunHost(
      baseHost,
      this.children.createHost(baseHost, options.childProjection),
    );
    return this.session.submitMessage(content, { ...options, host });
  }

  async runMessage(
    content: string | ContentBlock[],
    options: OpenHarnessAgentSubmitOptions = {},
  ): Promise<AgentSessionRunResult> {
    const events: import("@openharness/core").StreamEvent[] = [];
    let output = "";
    for await (const event of this.submitMessage(content, options)) {
      events.push(event);
      if (event.type === "text_delta") output += event.delta;
    }
    return { output, events, history: this.getHistory() };
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
    await this.children.closeAll();
    await this.runtime.close();
  }
}

export function composeAgentRunHost(
  baseHost: AgentRunHost,
  childAgentHost: AgentChildAgentHost,
): AgentRunHost {
  return {
    scope: baseHost.scope,
    childAgentHost,
    emitEvent: (event) => baseHost.emitEvent(event),
    emitStreamEvent: (event) => baseHost.emitStreamEvent(event),
    requestPermission: (request) => baseHost.requestPermission(request),
  };
}

export async function createOpenHarnessAgent(
  options: OpenHarnessAgentOptions = {},
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
    if (Object.keys(mcpServers).length > 0) {
      await mcpManager.connectAll(mcpServers);
    }
    for (const tool of mcpManager.getAsToolDefinitions()) {
      runtime.toolRegistry.register(tool);
    }
    runtime.queryEngine.setMcpManager(mcpManager);
    runtime.addCleanup(() => mcpManager.disconnectAll());

    const memory = settings.memory?.enabled === false
      ? undefined
      : await createAgentMemoryRuntime(cwd, settings.memory?.maxFiles ?? 10);
    runtime.queryEngine.setMemoryRetriever(memory
      ? (userInput) => memory.retrieve(userInput)
      : undefined);

    const session = createAgentSession({
      queryEngine: runtime.queryEngine,
      cwd,
      sessionId: options.sessionId,
      emitEvent: options.emitEvent,
      emitStreamEvent: options.emitStreamEvent,
      requestPermission: options.requestPermission,
    });
    const children = new AgentChildManager({
      settings,
      idleTtlMs: options.childIdleTtlMs,
      createAgent: (childOptions) => createOpenHarnessAgent(childOptions),
    });
    return new DefaultOpenHarnessAgent(
      runtime,
      session,
      mcpManager,
      memory,
      children,
      options.overrides?.model ?? settings.model,
    );
  } catch (error) {
    await runtime.close();
    throw error;
  }
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
