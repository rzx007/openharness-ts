import type {
  AgentSessionHostCallbacks,
  AgentSessionRunResult,
  AgentSessionSubmitOptions,
  ContentBlock,
  Message,
  RuntimeBundle,
  Settings,
  UsageSnapshot,
} from "@openharness/core";
import { createAgentSession, type AgentSession } from "@openharness/core";
import { McpClientManager, type McpConnection } from "@openharness/mcp";

import {
  createOpenHarnessRuntime,
  type OpenHarnessRuntimeOptions,
} from "./default-runtime.js";

export interface OpenHarnessAgentOptions
  extends OpenHarnessRuntimeOptions,
    AgentSessionHostCallbacks {
  mcpServers?: Settings["mcpServers"];
  configureRuntime?(bundle: RuntimeBundle): Promise<void> | void;
}

export class OpenHarnessAgent {
  constructor(
    readonly runtime: RuntimeBundle,
    readonly session: AgentSession,
    private readonly mcpManager: McpClientManager,
  ) {}

  get id(): string {
    return this.session.id;
  }

  submitMessage(content: string | ContentBlock[], options: AgentSessionSubmitOptions = {}) {
    return this.session.submitMessage(content, options);
  }

  runMessage(
    content: string | ContentBlock[],
    options: AgentSessionSubmitOptions = {},
  ): Promise<AgentSessionRunResult> {
    return this.session.runMessage(content, options);
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

  async compact(): Promise<Message[]> {
    await this.runtime.queryEngine.compact();
    return this.getHistory();
  }

  getUsage(): UsageSnapshot {
    return this.runtime.queryEngine.getTotalUsage();
  }

  getMcpConnections(): readonly McpConnection[] {
    return this.mcpManager.getConnections();
  }

  async close(): Promise<void> {
    await this.runtime.close();
  }
}

export async function createOpenHarnessAgent(
  options: OpenHarnessAgentOptions,
): Promise<OpenHarnessAgent> {
  const runtime = await createOpenHarnessRuntime(options);
  try {
    await options.configureRuntime?.(runtime);

    const mcpManager = new McpClientManager();
    const mcpServers = options.mcpServers ?? options.settings.mcpServers ?? {};
    if (Object.keys(mcpServers).length > 0) {
      await mcpManager.connectAll(mcpServers);
    }
    for (const tool of mcpManager.getAsToolDefinitions()) {
      runtime.toolRegistry.register(tool);
    }
    runtime.queryEngine.setMcpManager(mcpManager);
    runtime.addCleanup(() => mcpManager.disconnectAll());

    const session = createAgentSession({
      queryEngine: runtime.queryEngine,
      cwd: options.cwd ?? process.cwd(),
      sessionId: options.sessionId,
      childAgentHost: options.childAgentHost,
      emitEvent: options.emitEvent,
      emitStreamEvent: options.emitStreamEvent,
      requestPermission: options.requestPermission,
    });
    return new OpenHarnessAgent(runtime, session, mcpManager);
  } catch (error) {
    await runtime.close();
    throw error;
  }
}
