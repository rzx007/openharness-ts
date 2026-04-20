import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig, ToolDefinition } from "@openharness/core";

export type { McpServerConfig };

export interface McpResourceInfo {
  serverName: string;
  name: string;
  uri: string;
  description: string;
}

export interface McpConnection {
  name: string;
  config: McpServerConfig;
  status: "disconnected" | "connecting" | "connected" | "error";
  tools: McpToolInfo[];
  resources: McpResourceInfo[];
  error?: Error;
}

export interface McpToolInfo {
  serverName: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolCallResult {
  content: string;
  isError?: boolean;
}

export class McpClientManager {
  private connections = new Map<string, McpConnection>();
  private clients = new Map<string, Client>();
  private transports = new Map<string, StdioClientTransport>();

  async connect(name: string, config: McpServerConfig): Promise<McpConnection> {
    const connection: McpConnection = {
      name,
      config,
      status: "connecting",
      tools: [],
      resources: [],
    };
    this.connections.set(name, connection);

    try {
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env as Record<string, string> | undefined,
      });
      this.transports.set(name, transport);

      const client = new Client(
        { name: "openharness", version: "0.1.0" },
        { capabilities: {} }
      );
      await client.connect(transport);
      this.clients.set(name, client);

      const [toolsResult, resourcesResult] = await Promise.all([
        client.listTools().catch(() => ({ tools: [] })),
        client.listResources().catch(() => ({ resources: [] })),
      ]);

      const tools: McpToolInfo[] = (toolsResult.tools as any[]).map((t) => ({
        serverName: name,
        name: t.name,
        description: t.description ?? "",
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? {
          type: "object",
          properties: {},
        },
      }));

      const resources: McpResourceInfo[] = (resourcesResult.resources as any[]).map(
        (r) => ({
          serverName: name,
          name: r.name ?? String(r.uri),
          uri: String(r.uri),
          description: r.description ?? "",
        })
      );

      connection.tools = tools;
      connection.resources = resources;
      connection.status = "connected";
    } catch (err) {
      connection.status = "error";
      connection.error = err instanceof Error ? err : new Error(String(err));
      this.clients.delete(name);
      this.transports.delete(name);
    }

    return connection;
  }

  async connectAll(servers: Record<string, McpServerConfig>): Promise<void> {
    await Promise.allSettled(
      Object.entries(servers).map(([name, config]) => this.connect(name, config))
    );
  }

  async disconnect(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client) {
      try {
        await client.close();
      } catch { }
    }
    this.clients.delete(name);
    this.transports.delete(name);

    const connection = this.connections.get(name);
    if (connection) {
      connection.status = "disconnected";
      connection.tools = [];
      connection.resources = [];
      this.connections.delete(name);
    }
  }

  async disconnectAll(): Promise<void> {
    for (const name of [...this.connections.keys()]) {
      await this.disconnect(name);
    }
  }

  async reconnect(name: string): Promise<McpConnection | undefined> {
    const existing = this.connections.get(name);
    if (existing) {
      await this.disconnect(name);
      return this.connect(name, existing.config);
    }
    return undefined;
  }

  getConnection(name: string): McpConnection | undefined {
    return this.connections.get(name);
  }

  getConnections(): readonly McpConnection[] {
    return [...this.connections.values()];
  }

  getConnectedTools(): McpToolInfo[] {
    return [...this.connections.values()].flatMap((c) =>
      c.status === "connected" ? c.tools : []
    );
  }

  getConnectedResources(): McpResourceInfo[] {
    return [...this.connections.values()].flatMap((c) =>
      c.status === "connected" ? c.resources : []
    );
  }

  getAsToolDefinitions(): ToolDefinition[] {
    return this.getConnectedTools().map(
      (t): ToolDefinition => ({
        name: `mcp__${t.serverName}__${t.name}`,
        description: `[${t.serverName}] ${t.description}`,
        inputSchema: t.inputSchema,
        execute: async (input) => {
          const result = await this.callTool(t.serverName, t.name, input);
          return {
            content: [{ type: "text" as const, text: result.content }],
            isError: result.isError,
          };
        },
      })
    );
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<McpToolCallResult> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server not found: ${serverName}`);
    }

    try {
      const result = await client.callTool({ name: toolName, arguments: args });
      const parts: string[] = [];
      for (const item of result.content as any[]) {
        if (item.type === "text") {
          parts.push(item.text ?? "");
        } else {
          parts.push(JSON.stringify(item));
        }
      }
      return {
        content: parts.join("\n").trim() || "(no output)",
        isError: !!(result.isError as boolean | undefined),
      };
    } catch (err) {
      return {
        content: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  }

  async readResource(serverName: string, uri: string): Promise<string> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server not found: ${serverName}`);
    }

    const result = await client.readResource({ uri });
    const parts: string[] = [];
    for (const item of result.contents as any[]) {
      if (item.text !== undefined) {
        parts.push(item.text);
      } else if (item.blob !== undefined) {
        parts.push(item.blob);
      } else {
        parts.push(JSON.stringify(item));
      }
    }
    return parts.join("\n").trim();
  }
}
