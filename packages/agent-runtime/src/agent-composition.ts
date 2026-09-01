import { randomUUID } from "node:crypto";

import type {
  AgentSession,
  McpServerConfig,
  RuntimeBundle,
  Settings,
} from "@openharness/core";
import { createAgentSession, loadSettings } from "@openharness/core";
import { FileWorkflowRunRepository } from "@openharness/coordinator";
import { CompositeAgentJobHost, type AgentJobHost } from "@openharness/jobs";
import { McpClientManager } from "@openharness/mcp";
import { appendUserProfileUpdate } from "@openharness/prompts";
import { LocalAgentJobHost } from "@openharness/tools";

import type {
  AgentCapabilityOverrides,
  AgentEffectOverrides,
  ObservableJobProducer,
  OpenHarnessAgentConfiguration,
} from "./agent-options.js";
import {
  assertJobConfiguration,
  disabledCapability,
  resolveCapability,
  unavailableCapability,
  type ResolvedAgentCapabilities,
  type ResolvedCapability,
} from "./capability-resolution.js";
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
import { createRememberTool } from "./remember-tool.js";

interface AgentCompositionOptions extends OpenHarnessAgentConfiguration {
  settings?: Settings;
  cwd?: string;
  sessionId?: string;
  mcpServers?: Record<string, McpServerConfig>;
  extensions?: OpenHarnessAgentExtension[];
  childIdleTtlMs?: number;
  capabilityOverrides?: AgentCapabilityOverrides;
  effects?: AgentEffectOverrides;
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
}

export interface AgentComposition {
  runtime: RuntimeBundle;
  session: AgentSession;
  mcpConnections: () => ReturnType<McpClientManager["getConnections"]>;
  memory: AgentMemoryRuntime | undefined;
  childManager: AgentChildManager;
  capabilities: ResolvedAgentCapabilities;
  model: string;
}

export async function composeOpenHarnessAgent(
  options: AgentCompositionOptions,
  internal: AgentCompositionContext,
): Promise<AgentComposition> {
  const cwd = options.cwd ?? process.cwd();
  const settings = options.settings ?? (await loadSettings({}));
  const overrides = options.capabilityOverrides ?? {};
  assertJobConfiguration(overrides);

  const discovery = await discoverOpenHarnessExtensions(cwd, settings, {
    pluginsEnabled: options.pluginsEnabled,
  });
  for (const warning of discovery.warnings) {
    process.stderr.write(`[plugins] ${warning}\n`);
  }

  const sessionId = options.sessionId ?? `agent_session_${randomUUID()}`;
  const childEnvironment = await resolveCapability(
    overrides.childEnvironment,
    async () => createDefaultChildEnvironmentProvider(),
  );
  const childManager = new AgentChildManager({
    settings,
    configuration: options,
    capabilityOverrides: options.capabilityOverrides,
    effects: options.effects,
    cwd,
    idleTtlMs: options.childIdleTtlMs,
    eventBus: internal.eventBus,
    directory: internal.childDirectory,
    environment: capabilityValue(childEnvironment) ?? unavailableChildEnvironment(),
    onWarning: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
    createAgent: internal.createAgent,
  });

  const workflowRepository = await resolveCapability(
    overrides.workflowRepository,
    async () => new FileWorkflowRunRepository({ cwd }),
  );
  const localJobs = overrides.jobs === false
    ? undefined
    : new LocalAgentJobHost(cwd, sessionId, childManager);

  const jobSources: AgentJobHost[] = [];
  if (localJobs) jobSources.push(localJobs);
  const terminal = resolveProducerOverride(
    overrides.terminal,
    "Default Node runtime does not provide terminal",
    jobSources,
  );
  const backgroundShell = overrides.backgroundShell === undefined
    ? localJobs ? {
        status: "available" as const,
        value: localJobs,
        source: "default" as const,
      } : unavailableCapability("Default Node runtime does not provide background shell")
    : resolveProducerOverride(
        overrides.backgroundShell,
        "Default Node runtime does not provide background shell",
        jobSources,
      );
  const jobs = overrides.jobs === false
    ? disabledCapability<AgentJobHost>()
    : {
        status: "available" as const,
        value: new CompositeAgentJobHost(jobSources),
        source: hasProducerOverride(overrides) ? "override" as const : "default" as const,
      };

  const memory = await resolveCapability(
    overrides.memory === false || settings.memory?.enabled === false
      ? false
      : undefined,
    async () => createAgentMemoryRuntime(cwd, settings.memory?.maxFiles ?? 10),
  );
  const attachments = resolveOptionalOverride(
    overrides.attachments,
    "Default Node runtime does not provide attachments",
  );
  const imageToText = resolveOptionalOverride(
    overrides.imageToText,
    "Default Node runtime does not provide image to text",
  );
  const schedules = resolveOptionalOverride(
    overrides.schedules,
    "Default Node runtime does not provide schedules",
  );

  const capabilities: ResolvedAgentCapabilities = {
    terminal,
    backgroundShell,
    jobs,
    attachments,
    memory,
    childEnvironment,
    workflowRepository,
    imageToText,
    schedules,
  };

  const runtime = await createOpenHarnessRuntime({
    settings,
    cwd,
    sessionId,
    configuration: options,
    capabilities,
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

    const mcpManager = new McpClientManager({ cwd, settings, sessionId });
    runtime.addCleanup(() => mcpManager.disconnectAll());
    const mcpServers = options.mcpServers ?? discovery.mcpServers;
    if (Object.keys(mcpServers).length > 0) {
      await mcpManager.connectAll(mcpServers);
    }
    for (const tool of mcpManager.getAsToolDefinitions()) {
      runtime.toolRegistry.register(tool);
    }
    runtime.queryEngine.setMcpManager(mcpManager);
    runtime.queryEngine.setMcpAuth(
      createMcpAuthHost({ settings, mcpManager, toolRegistry: runtime.toolRegistry }),
    );

    const memoryRuntime = capabilityValue(memory);
    runtime.toolRegistry.register(createRememberTool({
      appendUserProfile: appendUserProfileUpdate,
      projectMemory: memoryRuntime?.manager,
    }));
    runtime.queryEngine.setMemoryRetriever(
      memoryRuntime ? (userInput) => memoryRuntime.retrieve(userInput) : undefined,
    );

    const session = createAgentSession({ queryEngine: runtime.queryEngine, sessionId });
    return {
      runtime,
      session,
      mcpConnections: () => mcpManager.getConnections(),
      memory: memoryRuntime,
      childManager,
      capabilities,
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

function capabilityValue<T>(
  capability: ResolvedCapability<T>,
): T | undefined {
  return capability.status === "available" ? capability.value : undefined;
}

function resolveOptionalOverride<T>(
  override: T | false | undefined,
  unavailableReason: string,
): ResolvedCapability<T> {
  if (override === false) return disabledCapability();
  if (override !== undefined) {
    return { status: "available", value: override, source: "override" };
  }
  return unavailableCapability(unavailableReason);
}

function resolveProducerOverride<T>(
  override: ObservableJobProducer<T> | false | undefined,
  unavailableReason: string,
  jobSources: AgentJobHost[],
): ResolvedCapability<T> {
  if (override === false) return disabledCapability();
  if (override === undefined) return unavailableCapability(unavailableReason);
  jobSources.push(override.jobs);
  return { status: "available", value: override.value, source: "override" };
}

function hasProducerOverride(overrides: AgentCapabilityOverrides): boolean {
  return (
    overrides.terminal !== undefined && overrides.terminal !== false
  ) || (
    overrides.backgroundShell !== undefined && overrides.backgroundShell !== false
  );
}

function unavailableChildEnvironment(): AgentChildEnvironmentProvider {
  return {
    async acquire() {
      throw new Error("Child environment capability is not available");
    },
  };
}
