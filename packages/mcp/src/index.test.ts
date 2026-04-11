import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpClientManager } from "./index.js";
import type { McpConnection, McpToolInfo, McpResourceInfo } from "./index.js";

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  const tools = [
    { name: "read_file", description: "Read a file", inputSchema: { type: "object" } },
    { name: "write_file", description: "Write a file", inputSchema: { type: "object" } },
  ];
  const resources = [
    { name: "config", uri: "file:///config.json", description: "Config file" },
  ];

  return {
    Client: vi.fn().mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools }),
      listResources: vi.fn().mockResolvedValue({ resources }),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "result data" }],
        isError: false,
      }),
      readResource: vi.fn().mockResolvedValue({
        contents: [{ text: "resource content" }],
      }),
    })),
  };
});

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({})),
}));

describe("McpClientManager", () => {
  let manager: McpClientManager;

  beforeEach(() => {
    manager = new McpClientManager();
  });

  it("connects to a server and discovers tools", async () => {
    const conn = await manager.connect("test-server", {
      command: "node",
      args: ["server.js"],
    });

    expect(conn.status).toBe("connected");
    expect(conn.tools).toHaveLength(2);
    expect(conn.tools[0]!.name).toBe("read_file");
    expect(conn.tools[1]!.name).toBe("write_file");
    expect(conn.resources).toHaveLength(1);
    expect(conn.resources[0]!.name).toBe("config");
  });

  it("disconnects from a server", async () => {
    await manager.connect("test", { command: "node" });
    await manager.disconnect("test");

    const conn = manager.getConnection("test");
    expect(conn).toBeUndefined();
  });

  it("disconnectAll removes all connections", async () => {
    await manager.connect("s1", { command: "node" });
    await manager.connect("s2", { command: "node" });
    await manager.disconnectAll();

    expect(manager.getConnections()).toHaveLength(0);
  });

  it("getConnections returns all connections", async () => {
    await manager.connect("a", { command: "node" });
    await manager.connect("b", { command: "node" });

    const conns = manager.getConnections();
    expect(conns).toHaveLength(2);
  });

  it("getConnectedTools returns tools from connected servers only", async () => {
    await manager.connect("active", { command: "node" });
    manager["connections"].set("dead", {
      name: "dead",
      config: { command: "node" },
      status: "error",
      tools: [{ serverName: "dead", name: "x", description: "", inputSchema: {} }],
      resources: [],
      error: new Error("fail"),
    });

    const tools = manager.getConnectedTools();
    expect(tools).toHaveLength(2);
    expect(tools.every((t) => t.serverName === "active")).toBe(true);
  });

  it("getAsToolDefinitions wraps MCP tools with mcp__ prefix", async () => {
    await manager.connect("fs", { command: "node" });

    const defs = manager.getAsToolDefinitions();
    expect(defs).toHaveLength(2);
    expect(defs[0]!.name).toBe("mcp__fs__read_file");
    expect(defs[0]!.description).toContain("[fs]");
    expect(typeof defs[0]!.execute).toBe("function");
  });

  it("callTool throws for unknown server", async () => {
    await expect(
      manager.callTool("nope", "tool", {})
    ).rejects.toThrow("MCP server not found");
  });

  it("callTool delegates to client and returns result", async () => {
    await manager.connect("test", { command: "node" });

    const result = await manager.callTool("test", "read_file", { path: "/tmp" });
    expect(result.content).toBe("result data");
    expect(result.isError).toBe(false);
  });

  it("readResource throws for unknown server", async () => {
    await expect(
      manager.readResource("nope", "file:///x")
    ).rejects.toThrow("MCP server not found");
  });

  it("readResource returns resource content", async () => {
    await manager.connect("test", { command: "node" });

    const content = await manager.readResource("test", "file:///config.json");
    expect(content).toBe("resource content");
  });

  it("handles connection failure gracefully", async () => {
    vi.mocked(
      (await import("@modelcontextprotocol/sdk/client/index.js")).Client
    ).mockImplementationOnce(() => ({
      connect: vi.fn().mockRejectedValue(new Error("spawn failed")),
      close: vi.fn(),
      listTools: vi.fn(),
      listResources: vi.fn(),
      callTool: vi.fn(),
      readResource: vi.fn(),
    }));

    const conn = await manager.connect("bad", { command: "nonexistent" });
    expect(conn.status).toBe("error");
    expect(conn.error).toBeDefined();
  });

  it("getConnectedResources returns resources from connected servers", async () => {
    await manager.connect("test", { command: "node" });

    const resources = manager.getConnectedResources();
    expect(resources).toHaveLength(1);
    expect(resources[0]!.uri).toBe("file:///config.json");
  });
});
