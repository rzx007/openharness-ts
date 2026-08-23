import type {
  McpAuthConfigureInput,
  McpAuthHost,
  McpServerConfig,
  Settings,
  IToolRegistry,
} from "@openharness/core";
import { saveSettings } from "@openharness/core";
import { McpClientManager, resolveTransportKind } from "@openharness/mcp";

export interface CreateMcpAuthHostOptions {
  settings: Settings;
  mcpManager: McpClientManager;
  toolRegistry: IToolRegistry;
  persistSettings?: (settings: Settings) => Promise<void>;
}

export function createMcpAuthHost(options: CreateMcpAuthHostOptions): McpAuthHost {
  const persistSettings = options.persistSettings ?? saveSettings;
  return {
    async configure(input) {
      const existing = options.settings.mcpServers?.[input.serverName]
        ?? options.mcpManager.getConnection(input.serverName)?.config;
      if (!existing) {
        throw new Error(`MCP server is not configured: ${input.serverName}`);
      }

      const nextConfig = applyMcpAuthConfig(input.serverName, existing, input);
      const nextSettings: Settings = {
        ...options.settings,
        mcpServers: {
          ...(options.settings.mcpServers ?? {}),
          [input.serverName]: nextConfig,
        },
      };

      assertMcpToolUnregisterAvailable(options.toolRegistry, input.serverName);
      await persistSettings(nextSettings);
      Object.assign(options.settings, nextSettings);

      unregisterMcpServerTools(options.toolRegistry, input.serverName);
      const connection = await options.mcpManager.reconnect(input.serverName, nextConfig);
      for (const tool of options.mcpManager.getAsToolDefinitions()) {
        if (tool.name.startsWith(`mcp__${input.serverName}__`)) {
          options.toolRegistry.register(tool);
        }
      }

      if (!connection) {
        throw new Error(`Saved MCP auth for ${input.serverName}, but reconnect did not run.`);
      }
      if (connection.status !== "connected") {
        const detail = connection.error ? `: ${connection.error.message}` : "";
        throw new Error(`Saved MCP auth for ${input.serverName}, but reconnect failed${detail}`);
      }

      return {
        message: `Saved MCP auth for ${input.serverName} and reconnected it (mode=${input.mode}).`,
      };
    },
  };
}

function assertMcpToolUnregisterAvailable(toolRegistry: IToolRegistry, serverName: string): void {
  if (typeof toolRegistry.unregister === "function") return;
  throw new Error(
    `Cannot reconnect MCP server ${serverName}: the active tool registry cannot remove old MCP tools.`,
  );
}

function unregisterMcpServerTools(toolRegistry: IToolRegistry, serverName: string): void {
  const prefix = `mcp__${serverName}__`;
  for (const tool of toolRegistry.getAll()) {
    if (tool.name.startsWith(prefix)) toolRegistry.unregister?.(tool.name);
  }
}

export function applyMcpAuthConfig(
  serverName: string,
  config: McpServerConfig,
  input: McpAuthConfigureInput,
): McpServerConfig {
  const kind = resolveTransportKind(config);
  if (typeof kind !== "string") {
    throw new Error(`Cannot configure MCP auth for ${serverName}: ${kind.error}`);
  }

  switch (input.mode) {
    case "bearer":
      if (config.type !== "http" && config.type !== "sse") {
        throw new Error(`MCP auth mode bearer only works for HTTP/SSE servers. Use env for stdio server ${serverName}.`);
      }
      return {
        ...config,
        headers: {
          ...(config.headers ?? {}),
          Authorization: `Bearer ${input.value}`,
        },
      };
    case "header":
      if (config.type !== "http" && config.type !== "sse") {
        throw new Error(`MCP auth mode header only works for HTTP/SSE servers. Use env for stdio server ${serverName}.`);
      }
      if (!input.key?.trim()) {
        throw new Error("MCP auth mode header requires a header key.");
      }
      return {
        ...config,
        headers: {
          ...(config.headers ?? {}),
          [input.key]: input.value,
        },
      };
    case "env": {
      if (config.type !== "stdio") {
        throw new Error(`MCP auth mode env only works for stdio servers. Use bearer or header for ${kind} server ${serverName}.`);
      }
      const envKey = input.key?.trim() || defaultMcpEnvKey(serverName);
      return {
        ...config,
        env: {
          ...(config.env ?? {}),
          [envKey]: input.value,
        },
      };
    }
  }
}

export function defaultMcpEnvKey(serverName: string): string {
  return `${serverName.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}_API_KEY`;
}
