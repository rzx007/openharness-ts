import { randomUUID } from "node:crypto";

import type {
  AgentSession,
  McpServerConfig,
  RuntimeBundle,
  Settings,
} from "@openharness/core";
import { createAgentSession, loadSettings } from "@openharness/core";
import type { McpClientManager } from "@openharness/mcp";

import type {
  AgentCapabilityOverrides,
  AgentEffectOverrides,
  OpenHarnessAgentConfiguration,
} from "./agent-options.js";
import type { ResolvedAgentCapabilities } from "./capability-resolution.js";
import type {
  AgentChildManager,
  AgentChildManagerOptions,
  AgentChildRegistry,
} from "./child-agent.js";
import {
  CleanupStack,
  cleanupAfterInitializationFailure,
} from "./cleanup-stack.js";
import type { DefaultNodeTerminalResolution } from "./default-node-terminal.js";
import { resolveDefaultAgentCapabilities } from "./default-agent-capabilities.js";
import { createOpenHarnessRuntime } from "./default-runtime.js";
import type { AgentEventBus } from "./event-source.js";
import {
  discoverOpenHarnessExtensions,
  type OpenHarnessAgentExtension,
} from "./extensions.js";
import type { AgentMemoryRuntime } from "./memory-runtime.js";
import { installRuntimeIntegrations } from "./runtime-integrations.js";

interface AgentCompositionOptions extends OpenHarnessAgentConfiguration {
  settings?: Settings;
  cwd?: string;
  sessionId?: string;
  mcpServers?: Record<string, McpServerConfig>;
  extensions?: OpenHarnessAgentExtension[];
  childIdleTtlMs?: number;
  capabilityOverrides?: AgentCapabilityOverrides;
  effects?: AgentEffectOverrides;
  attachmentResourceRoot?: string;
}

export interface AgentIdentity {
  childId?: string;
  parentSessionId?: string;
  parentRunId?: string;
}

export interface AgentCompositionContext {
  eventBus: AgentEventBus;
  childDirectory: AgentChildRegistry;
  identity?: AgentIdentity;
  createAgent: AgentChildManagerOptions["createAgent"];
  resolveDefaultTerminal(input: {
    override: AgentCapabilityOverrides["terminal"];
    cwd: string;
    sessionId: string;
  }): Promise<DefaultNodeTerminalResolution>;
}

export interface AgentComposition {
  runtime: RuntimeBundle;
  session: AgentSession;
  mcpConnections: () => ReturnType<McpClientManager["getConnections"]>;
  memory: AgentMemoryRuntime | undefined;
  childManager: AgentChildManager;
  capabilities: ResolvedAgentCapabilities;
  model: string;
  cleanup: CleanupStack;
}

export async function composeOpenHarnessAgent(
  options: AgentCompositionOptions,
  internal: AgentCompositionContext,
): Promise<AgentComposition> {
  const cleanup = new CleanupStack();
  const rollback = new CleanupStack();
  rollback.add(() => cleanup.close(), cleanup);
  try {
    return await composeOpenHarnessAgentInternal(
      options,
      internal,
      cleanup,
      rollback,
    );
  } catch (error) {
    return await cleanupAfterInitializationFailure(rollback, error);
  }
}

async function composeOpenHarnessAgentInternal(
  options: AgentCompositionOptions,
  internal: AgentCompositionContext,
  cleanup: CleanupStack,
  rollback: CleanupStack,
): Promise<AgentComposition> {
  const cwd = options.cwd ?? process.cwd();
  const settings = options.settings ?? (await loadSettings({}));
  const discovery = await discoverOpenHarnessExtensions(cwd, settings, {
    pluginsEnabled: options.pluginsEnabled,
  });
  for (const warning of discovery.warnings) {
    process.stderr.write(`[plugins] ${warning}\n`);
  }

  const sessionId = options.sessionId ?? `agent_session_${randomUUID()}`;
  const environment = await resolveDefaultAgentCapabilities({
    settings,
    configuration: options,
    capabilityOverrides: options.capabilityOverrides,
    effects: options.effects,
    cwd,
    sessionId,
    childIdleTtlMs: options.childIdleTtlMs,
    eventBus: internal.eventBus,
    childDirectory: internal.childDirectory,
    createAgent: internal.createAgent,
    resolveDefaultTerminal: internal.resolveDefaultTerminal,
    cleanup,
  });

  const runtime = await createOpenHarnessRuntime({
    settings,
    cwd,
    sessionId,
    configuration: options,
    capabilities: environment.capabilities,
    attachmentResourceRoot: options.attachmentResourceRoot,
    skillRegistry: discovery.skillRegistry,
    agentDefinitions: discovery.agentDefinitions,
  });
  rollback.add(() => runtime.close(), runtime);

  const mcpConnections = await installRuntimeIntegrations({
    cwd,
    sessionId,
    settings,
    runtime,
    discovery,
    extensions: options.extensions,
    mcpServers: options.mcpServers,
    memory: environment.memory,
  });
  const session = createAgentSession({
    queryEngine: runtime.queryEngine,
    sessionId,
  });

  return {
    runtime,
    session,
    mcpConnections,
    memory: environment.memory,
    childManager: environment.childManager,
    capabilities: environment.capabilities,
    model: options.model ?? settings.model,
    cleanup,
  };
}
