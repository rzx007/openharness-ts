import type {
  AgentEffects,
  AgentSession,
  McpServerConfig,
  RuntimeBundle,
  Settings,
} from "@openharness/core";
import { createAgentSession, loadSettings } from "@openharness/core";
import { McpClientManager } from "@openharness/mcp";
import { LocalAgentJobHost } from "@openharness/tools";

import type {
  AgentHostCapabilities,
  OpenHarnessAgentConfiguration,
} from "./agent-options.js";
import {
  AgentChildManager,
  type AgentChildEnvironmentProvider,
  type AgentChildManagerOptions,
  type AgentChildRegistry,
} from "./child-agent.js";
import { createDefaultChildEnvironmentProvider } from "./child-environment.js";
import { createOpenHarnessRuntime } from "./default-runtime.js";
import type { AgentEventBus } from "./event-source.js";
import {
  configureDiscoveredExtensions,
  discoverOpenHarnessExtensions,
  type OpenHarnessAgentExtension,
} from "./extensions.js";
import {
  createAgentMemoryRuntime,
  type AgentMemoryRuntime,
} from "./memory-runtime.js";
import { createMcpAuthHost } from "./mcp-auth.js";

interface AgentCompositionOptions extends OpenHarnessAgentConfiguration {
  settings?: Settings;
  cwd?: string;
  sessionId?: string;
  mcpServers?: Record<string, McpServerConfig>;
  extensions?: OpenHarnessAgentExtension[];
  childIdleTtlMs?: number;
  hostCapabilities?: AgentHostCapabilities;
}

export interface AgentIdentity {
  childId?: string;
  parentSessionId?: string;
  parentRunId?: string;
}

export interface AgentCompositionContext {
  eventBus: AgentEventBus;
  effects: AgentEffects;
  childDirectory: AgentChildRegistry;
  identity?: AgentIdentity;
  createAgent: AgentChildManagerOptions["createAgent"];
}

export interface AgentComposition {
  runtime: RuntimeBundle;
  session: AgentSession;
  mcpConnections: () => ReturnType<McpClientManager["getConnections"]>;
  memory: AgentMemoryRuntime | undefined;
  childManager: AgentChildManager;
  hostCapabilities: string[];
  model: string;
}

export async function composeOpenHarnessAgent(
  options: AgentCompositionOptions,
  internal: AgentCompositionContext,
): Promise<AgentComposition> {
  const cwd = options.cwd ?? process.cwd();
  const settings = options.settings ?? (await loadSettings({}));
  const explicitCapabilities = options.hostCapabilities;
  const discovery = await discoverOpenHarnessExtensions(cwd, settings, {
    pluginsEnabled: options.pluginsEnabled,
  });
  for (const warning of discovery.warnings)
    process.stderr.write(`[plugins] ${warning}\n`);
  const runtime = await createOpenHarnessRuntime({
    settings,
    cwd,
    sessionId: options.sessionId,
    configuration: options,
    hostCapabilities: {
      schedules: Boolean(explicitCapabilities?.schedules ?? internal.effects.schedules),
      terminal: Boolean(explicitCapabilities?.terminal),
      jobs: Boolean(explicitCapabilities?.jobs) || !explicitCapabilities,
      workflowRepository: explicitCapabilities?.workflowRepository,
      imageToText: Boolean(explicitCapabilities?.imageToText),
      attachments: Boolean(explicitCapabilities?.attachments),
      contextMemory: Boolean(explicitCapabilities?.contextMemory),
      attachmentResourceRoot: explicitCapabilities?.attachmentResourceRoot,
    },
    skillRegistry: discovery.skillRegistry,
    agentDefinitions: discovery.agentDefinitions,
  });
  try {
    await configureDiscoveredExtensions(discovery, {
      cwd,
      toolRegistry: runtime.toolRegistry,
      hookExecutor: runtime.hookExecutor,
      addCleanup: (cleanup, cleanupSync) => runtime.addCleanup(cleanup, cleanupSync),
    });
    for (const extension of options.extensions ?? []) {
      await extension.setup({
        cwd,
        settings,
        skillRegistry: discovery.skillRegistry,
        toolRegistry: runtime.toolRegistry,
        hookExecutor: runtime.hookExecutor,
      });
    }

    const mcpManager = new McpClientManager({
      cwd,
      settings,
      sessionId: options.sessionId,
    });
    runtime.addCleanup(() => mcpManager.disconnectAll());
    const mcpServers = options.mcpServers ?? discovery.mcpServers;
    if (Object.keys(mcpServers).length > 0)
      await mcpManager.connectAll(mcpServers);
    for (const tool of mcpManager.getAsToolDefinitions())
      runtime.toolRegistry.register(tool);
    runtime.queryEngine.setMcpManager(mcpManager);
    runtime.queryEngine.setMcpAuth(
      createMcpAuthHost({
        settings,
        mcpManager,
        toolRegistry: runtime.toolRegistry,
      }),
    );
    runtime.queryEngine.setTerminal(explicitCapabilities?.terminal);

    const memory =
      settings.memory?.enabled === false
        ? undefined
        : await createAgentMemoryRuntime(cwd, settings.memory?.maxFiles ?? 10);
    runtime.queryEngine.setMemoryRetriever(
      memory ? (userInput) => memory.retrieve(userInput) : undefined,
    );

    const session = createAgentSession({
      queryEngine: runtime.queryEngine,
      sessionId: options.sessionId,
    });
    const childManager = new AgentChildManager({
      settings,
      configuration: options,
      cwd,
      idleTtlMs: options.childIdleTtlMs,
      eventBus: internal.eventBus,
      directory: internal.childDirectory,
      environment:
        explicitCapabilities?.childEnvironment ??
        createDefaultChildEnvironmentProvider(),
      hostCapabilities: explicitCapabilities,
      onWarning: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
      createAgent: internal.createAgent,
    });
    const localJobs = !explicitCapabilities
      ? new LocalAgentJobHost(cwd, session.id, childManager)
      : undefined;
    const jobs = explicitCapabilities?.jobs ?? localJobs;
    runtime.queryEngine.setJobs(jobs);
    const backgroundShell =
      explicitCapabilities?.backgroundShell ??
      localJobs;
    runtime.queryEngine.setBackgroundShell(backgroundShell);
    runtime.queryEngine.setImageToText(explicitCapabilities?.imageToText);
    runtime.queryEngine.setAttachments(explicitCapabilities?.attachments);
    runtime.queryEngine.setContextMemory(explicitCapabilities?.contextMemory);
    const hostCapabilities = [
      "permissions",
      ...(jobs ? ["jobs"] : []),
      ...(backgroundShell ? ["backgroundShell"] : []),
      ...(explicitCapabilities?.terminal ? ["terminal"] : []),
      ...(explicitCapabilities?.schedules ?? internal.effects.schedules
        ? ["schedules"]
        : []),
      ...(!explicitCapabilities || explicitCapabilities.childEnvironment
        ? ["childEnvironment"]
        : []),
      ...(explicitCapabilities?.workflowRepository ? ["workflowRepository"] : []),
      ...(explicitCapabilities?.imageToText ? ["imageToText"] : []),
      ...(explicitCapabilities?.attachments ? ["attachments"] : []),
      ...(explicitCapabilities?.contextMemory ? ["contextMemory"] : []),
    ];
    return {
      runtime,
      session,
      mcpConnections: () => mcpManager.getConnections(),
      memory,
      childManager,
      hostCapabilities,
      model: options.model ?? settings.model,
    };
  } catch (error) {
    try {
      await runtime.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Agent creation and cleanup failed",
      );
    }
    throw error;
  }
}
