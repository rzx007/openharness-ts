import type { McpServerConfig, ToolDefinition } from "@openharness/core";

export type { McpServerConfig };

export interface McpConnection {
  name: string;
  config: McpServerConfig;
  status: "disconnected" | "connecting" | "connected" | "error";
  tools: ToolDefinition[];
  error?: Error;
}

export interface McpToolCallResult {
  content: unknown[];
  isError?: boolean;
}

export class McpClientManager {
  private connections = new Map<string, McpConnection>();

  async connect(
    name: string,
    config: McpServerConfig
  ): Promise<McpConnection> {
    const connection: McpConnection = {
      name,
      config,
      status: "connecting",
      tools: [],
    };
    this.connections.set(name, connection);

    try {
      const tools = await this.discoverTools(config);
      connection.tools = tools;
      connection.status = "connected";
    } catch (err) {
      connection.status = "error";
      connection.error = err instanceof Error ? err : new Error(String(err));
    }

    return connection;
  }

  async disconnect(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (connection) {
      connection.status = "disconnected";
      connection.tools = [];
      this.connections.delete(name);
    }
  }

  async disconnectAll(): Promise<void> {
    for (const name of this.connections.keys()) {
      await this.disconnect(name);
    }
  }

  getConnection(name: string): McpConnection | undefined {
    return this.connections.get(name);
  }

  getConnections(): readonly McpConnection[] {
    return [...this.connections.values()];
  }

  getConnectedTools(): ToolDefinition[] {
    return [...this.connections.values()].flatMap((c) =>
      c.status === "connected" ? c.tools : []
    );
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<McpToolCallResult> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`MCP server not found: ${serverName}`);
    }
    if (connection.status !== "connected") {
      throw new Error(`MCP server not connected: ${serverName}`);
    }
    void toolName;
    void args;
    return { content: [] };
  }

  private async discoverTools(
    _config: McpServerConfig
  ): Promise<ToolDefinition[]> {
    return [];
  }
}
