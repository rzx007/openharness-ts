import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpClientManager, resolveTransportKind } from "./index.js";
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
  StdioClientTransport: vi.fn().mockImplementation(() => ({ kind: "stdio" })),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi
    .fn()
    .mockImplementation(() => ({ kind: "http" })),
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: vi.fn().mockImplementation(() => ({ kind: "sse" })),
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
      transport: "stdio",
      authConfigured: false,
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

  it("uses StreamableHTTPClientTransport with headers for http servers", async () => {
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    vi.mocked(StreamableHTTPClientTransport).mockClear();

    const headers = { Authorization: "Bearer token-123" };
    const conn = await manager.connect("http-srv", {
      url: "https://example.com/mcp",
      headers,
    });

    expect(conn.status).toBe("connected");
    expect(conn.transport).toBe("http");
    expect(StreamableHTTPClientTransport).toHaveBeenCalledTimes(1);
    const [url, opts] = vi.mocked(StreamableHTTPClientTransport).mock
      .calls[0]!;
    expect(url).toBeInstanceOf(URL);
    expect((url as URL).href).toBe("https://example.com/mcp");
    expect(opts!.requestInit!.headers).toEqual(headers);
  });

  it("uses SSEClientTransport with headers for sse servers", async () => {
    const { SSEClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/sse.js"
    );
    vi.mocked(SSEClientTransport).mockClear();

    const headers = { "X-Api-Key": "secret" };
    const conn = await manager.connect("sse-srv", {
      type: "sse",
      url: "https://example.com/sse",
      headers,
    });

    expect(conn.status).toBe("connected");
    expect(conn.transport).toBe("sse");
    expect(SSEClientTransport).toHaveBeenCalledTimes(1);
    const [url, opts] = vi.mocked(SSEClientTransport).mock.calls[0]!;
    expect(url).toBeInstanceOf(URL);
    expect((url as URL).href).toBe("https://example.com/sse");
    expect(opts!.requestInit!.headers).toEqual(headers);
  });

  it("stdio servers still go through StdioClientTransport", async () => {
    const { StdioClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/stdio.js"
    );
    vi.mocked(StdioClientTransport).mockClear();

    const conn = await manager.connect("stdio-srv", {
      command: "node",
      args: ["server.js"],
    });

    expect(conn.status).toBe("connected");
    expect(conn.transport).toBe("stdio");
    expect(StdioClientTransport).toHaveBeenCalledTimes(1);
  });

  it("authConfigured reflects headers (http) and env (stdio)", async () => {
    const http = await manager.connect("http-auth", {
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer x" },
    });
    expect(http.authConfigured).toBe(true);

    const stdioAuth = await manager.connect("stdio-auth", {
      command: "node",
      env: { TOKEN: "abc" },
    });
    expect(stdioAuth.authConfigured).toBe(true);

    const stdioNoAuth = await manager.connect("stdio-noauth", {
      command: "node",
    });
    expect(stdioNoAuth.authConfigured).toBe(false);

    const httpNoAuth = await manager.connect("http-noauth", {
      url: "https://example.com/mcp",
    });
    expect(httpNoAuth.authConfigured).toBe(false);
  });

  it("invalid config sets status=error without throwing, in isolation", async () => {
    await manager.connectAll({
      bad: {} as any,
      good: { command: "node" },
    });

    const bad = manager.getConnection("bad");
    const good = manager.getConnection("good");
    expect(bad!.status).toBe("error");
    expect(bad!.error).toBeDefined();
    expect(good!.status).toBe("connected");
  });

  it("resources Method-not-found returns [] and does not fail connect", async () => {
    vi.mocked(
      (await import("@modelcontextprotocol/sdk/client/index.js")).Client
    ).mockImplementationOnce(
      () =>
        ({
          connect: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
          listTools: vi.fn().mockResolvedValue({ tools: [] }),
          listResources: vi
            .fn()
            .mockRejectedValue(new Error("MCP error -32601: Method not found")),
        }) as any
    );

    const conn = await manager.connect("no-resources", { command: "node" });
    expect(conn.status).toBe("connected");
    expect(conn.resources).toEqual([]);
    expect(conn.resourceError).toBeUndefined();
  });

  it("other resource errors are recorded but connect still succeeds", async () => {
    vi.mocked(
      (await import("@modelcontextprotocol/sdk/client/index.js")).Client
    ).mockImplementationOnce(
      () =>
        ({
          connect: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
          listTools: vi.fn().mockResolvedValue({ tools: [] }),
          listResources: vi
            .fn()
            .mockRejectedValue(new Error("connection reset")),
        }) as any
    );

    const conn = await manager.connect("flaky-resources", { command: "node" });
    expect(conn.status).toBe("connected");
    expect(conn.resources).toEqual([]);
    expect(conn.resourceError).toBeDefined();
    expect(conn.resourceError!.message).toContain("connection reset");
  });
});

describe("resolveTransportKind", () => {
  it("infers http from url", () => {
    expect(resolveTransportKind({ url: "https://x/mcp" })).toBe("http");
  });

  it("infers stdio from command", () => {
    expect(resolveTransportKind({ command: "node" })).toBe("stdio");
  });

  it("explicit type wins over inference (type=stdio with url)", () => {
    expect(
      resolveTransportKind({ type: "stdio", command: "node", url: "https://x" })
    ).toBe("stdio");
  });

  it("type=sse with url resolves to sse", () => {
    expect(resolveTransportKind({ type: "sse", url: "https://x/sse" })).toBe(
      "sse"
    );
  });

  it("missing both command and url returns error", () => {
    const r = resolveTransportKind({});
    expect(typeof r).toBe("object");
    expect((r as { error: string }).error).toMatch(/command|url/);
  });

  it("http/sse without url returns error", () => {
    expect((resolveTransportKind({ type: "http" }) as any).error).toMatch(
      /url/
    );
    expect((resolveTransportKind({ type: "sse" }) as any).error).toMatch(/url/);
  });

  it("stdio without command returns error", () => {
    expect(
      (resolveTransportKind({ type: "stdio" }) as any).error
    ).toMatch(/command/);
  });
});
