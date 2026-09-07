import { describe, expect, it } from "vitest";

import { selectMcpServersForEnvironment } from "./runtime-integrations.js";

const SERVERS = {
  local: { type: "stdio" as const, command: "node" },
  remote: { type: "http" as const, url: "https://mcp.example.test" },
};

describe("MCP execution domains", () => {
  it("keeps all configured transports for local execution", () => {
    expect(selectMcpServersForEnvironment(SERVERS)).toEqual(SERVERS);
  });

  it("keeps stdio and remote MCP in a networked Docker environment", () => {
    expect(selectMcpServersForEnvironment(SERVERS, {
      kind: "docker",
      networkMode: "bridge",
    })).toEqual(SERVERS);
  });

  it("keeps stdio MCP but removes remote MCP in a network-isolated Docker environment", () => {
    expect(selectMcpServersForEnvironment(SERVERS, {
      kind: "docker",
      networkMode: "none",
    })).toEqual({ local: SERVERS.local });
  });
});
