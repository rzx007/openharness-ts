import type { McpServerConfig, RuntimeBundle, Settings } from "@openharness/core";
import { McpClientManager } from "@openharness/mcp";
import { appendUserProfileUpdate } from "@openharness/prompts";

import type {
  OpenHarnessAgentExtension,
  OpenHarnessExtensionDiscovery,
} from "./extensions.js";
import {
  configureDiscoveredExtensions,
  createExtensionToolRegistry,
} from "./extensions.js";
import type { AgentMemoryRuntime } from "./memory-runtime.js";
import { createMcpAuthHost } from "./mcp-auth.js";
import { createRememberTool } from "./remember-tool.js";

export interface InstallRuntimeIntegrationsOptions {
  cwd: string;
  sessionId: string;
  settings: Settings;
  runtime: RuntimeBundle;
  discovery: OpenHarnessExtensionDiscovery;
  extensions?: OpenHarnessAgentExtension[];
  mcpServers?: Record<string, McpServerConfig>;
  memory?: AgentMemoryRuntime;
}

/** Install integrations that need a fully constructed RuntimeBundle. */
export async function installRuntimeIntegrations(
  options: InstallRuntimeIntegrationsOptions,
): Promise<() => ReturnType<McpClientManager["getConnections"]>> {
  const { runtime } = options;
  const memory = options.memory;
  await configureDiscoveredExtensions(options.discovery, {
    cwd: options.cwd,
    toolRegistry: runtime.toolRegistry,
    hookExecutor: runtime.hookExecutor,
    addCleanup: (cleanup, cleanupSync) => runtime.addCleanup(cleanup, cleanupSync),
  });
  for (const extension of options.extensions ?? []) {
    const registeredNames: string[] = [];
    try {
      await extension.setup({
        cwd: options.cwd,
        settings: options.settings,
        skillRegistry: options.discovery.skillRegistry,
        toolRegistry: createExtensionToolRegistry(
          runtime.toolRegistry,
          registeredNames,
        ),
        hookExecutor: runtime.hookExecutor,
      });
    } catch (error) {
      for (const name of registeredNames) runtime.toolRegistry.unregister?.(name);
      throw error;
    }
  }

  const mcpManager = new McpClientManager({
    cwd: options.cwd,
    settings: options.settings,
    sessionId: options.sessionId,
  });
  runtime.addCleanup(() => mcpManager.disconnectAll());
  const mcpServers = options.mcpServers ?? options.discovery.mcpServers;
  if (Object.keys(mcpServers).length > 0) {
    await mcpManager.connectAll(mcpServers);
  }
  const registeredMcpToolNames: string[] = [];
  try {
    for (const tool of mcpManager.getAsToolDefinitions()) {
      const serverName = readMcpServerName(tool.name);
      runtime.toolRegistry.register(tool, {
        kind: "mcp",
        ...(serverName ? { id: serverName } : {}),
      });
      registeredMcpToolNames.push(tool.name);
    }
  } catch (error) {
    for (const name of registeredMcpToolNames) {
      runtime.toolRegistry.unregister?.(name);
    }
    throw error;
  }
  runtime.queryEngine.setMcpManager(mcpManager);
  runtime.queryEngine.setMcpAuth(
    createMcpAuthHost({
      settings: options.settings,
      mcpManager,
      toolRegistry: runtime.toolRegistry,
    }),
  );

  if (memory) {
    runtime.toolRegistry.register(createRememberTool({
      appendUserProfile: appendUserProfileUpdate,
      projectMemory: memory.manager,
    }), { kind: "runtime", id: "memory" });
  }
  runtime.queryEngine.setMemoryRetriever(
    memory
      ? (userInput) => memory.retrieve(userInput)
      : undefined,
  );

  return () => mcpManager.getConnections();
}

function readMcpServerName(toolName: string): string | undefined {
  return /^mcp__(.+?)__/.exec(toolName)?.[1];
}
