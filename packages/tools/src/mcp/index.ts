import type { ToolDefinition } from "@openharness/core";

export const mcpToolCallTool: ToolDefinition = {
  name: "McpToolCall",
  description: "Call a tool on a connected MCP server.",
  inputSchema: {
    type: "object",
    properties: {
      serverName: { type: "string", description: "MCP server name" },
      toolName: { type: "string", description: "Tool name on the server" },
      args: { type: "object", description: "Tool arguments", default: {} },
    },
    required: ["serverName", "toolName"],
  },
  async execute(input, context) {
    const { McpClientManager } = await import("@openharness/mcp");
    const mgr = (context as any).mcpManager as McpClientManager | undefined;
    if (!mgr) {
      return { content: [{ type: "text", text: "MCP manager not available in context" }], isError: true };
    }
    try {
      const result = await mgr.callTool(input.serverName as string, input.toolName as string, (input.args as Record<string, unknown>) ?? {});
      return { content: [{ type: "text", text: result.content }], isError: result.isError };
    } catch (err) {
      return { content: [{ type: "text", text: (err as Error).message }], isError: true };
    }
  },
};

export const listMcpResourcesTool: ToolDefinition = {
  name: "ListMcpResources",
  description: "List resources from connected MCP servers.",
  inputSchema: {
    type: "object",
    properties: { serverName: { type: "string", description: "Optional server filter" } },
    required: [],
  },
  async execute(input, context) {
    const { McpClientManager } = await import("@openharness/mcp");
    const mgr = (context as any).mcpManager as McpClientManager | undefined;
    if (!mgr) return { content: [{ type: "text", text: "MCP manager not available" }], isError: true };
    const resources = mgr.getConnectedResources();
    const filtered = input.serverName ? resources.filter((r) => r.serverName === input.serverName) : resources;
    if (!filtered.length) return { content: [{ type: "text", text: "(no resources)" }] };
    const text = filtered.map((r) => `${r.serverName}: ${r.name} (${r.uri})`).join("\n");
    return { content: [{ type: "text", text }] };
  },
};

export const readMcpResourceTool: ToolDefinition = {
  name: "ReadMcpResource",
  description: "Read a resource from a connected MCP server.",
  inputSchema: {
    type: "object",
    properties: {
      serverName: { type: "string", description: "MCP server name" },
      uri: { type: "string", description: "Resource URI" },
    },
    required: ["serverName", "uri"],
  },
  async execute(input, context) {
    const { McpClientManager } = await import("@openharness/mcp");
    const mgr = (context as any).mcpManager as McpClientManager | undefined;
    if (!mgr) return { content: [{ type: "text", text: "MCP manager not available" }], isError: true };
    try {
      const content = await mgr.readResource(input.serverName as string, input.uri as string);
      return { content: [{ type: "text", text: content }] };
    } catch (err) {
      return { content: [{ type: "text", text: (err as Error).message }], isError: true };
    }
  },
};
