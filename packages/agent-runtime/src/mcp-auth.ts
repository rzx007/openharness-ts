import type {
  McpAuthConfigureInput,
  McpAuthHost,
  McpServerConfig,
  Settings,
  IToolRegistry,
} from "@openharness/core";
import { saveMcpServerConfig } from "@openharness/core";
import { McpClientManager, resolveTransportKind } from "@openharness/mcp";

export interface CreateMcpAuthHostOptions {
  settings: Settings;
  mcpManager: McpClientManager;
  toolRegistry: IToolRegistry;
  cwd?: string;
  persistMcpServer?: (
    serverName: string,
    config: McpServerConfig,
  ) => Promise<"project" | "global" | void>;
}

export function createMcpAuthHost(options: CreateMcpAuthHostOptions): McpAuthHost {
  const persistMcpServer = options.persistMcpServer
    ?? ((serverName, config) => saveMcpServerConfig(serverName, config, {
      projectRoot: options.cwd,
    }));

  let queue: Promise<unknown> = Promise.resolve();
  const runExclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
    const run = queue.then(operation, operation);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  return {
    async configure(input) {
      return runExclusive(async () => {
        const existing = options.settings.mcpServers?.[input.serverName]
          ?? options.mcpManager.getConnection(input.serverName)?.config;
        if (!existing) {
          throw new Error(`MCP server is not configured: ${input.serverName}`);
        }

        const previousConfig = existing;
        const previousStatus = options.mcpManager.getConnection(input.serverName)?.status;
        const nextConfig = applyMcpAuthConfig(input.serverName, existing, input);

        const connection = await options.mcpManager.reconnect(input.serverName, nextConfig);
        if (!connection || connection.status !== "connected") {
          if (previousStatus === "connected") {
            await options.mcpManager.reconnect(input.serverName, previousConfig);
          }
          const detail = connection?.error ? `: ${connection.error.message}` : "";
          throw new Error(
            `MCP auth reconnect failed for ${input.serverName}${detail}. Auth was not saved.`,
          );
        }

        try {
          await persistMcpServer(input.serverName, nextConfig);
        } catch (error) {
          await options.mcpManager.reconnect(input.serverName, previousConfig);
          throw error;
        }

        options.settings.mcpServers = {
          ...(options.settings.mcpServers ?? {}),
          [input.serverName]: nextConfig,
        };

        for (const tool of options.mcpManager.getAsToolDefinitions()) {
          if (tool.name.startsWith(`mcp__${input.serverName}__`)) {
            options.toolRegistry.register(tool);
          }
        }

        return {
          message: `Saved MCP auth for ${input.serverName} and reconnected it (mode=${input.mode}).`,
        };
      });
    },
  };
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
      if (kind !== "http" && kind !== "sse") {
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
      if (kind !== "http" && kind !== "sse") {
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
      if (kind !== "stdio") {
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
