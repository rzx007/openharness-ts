import { describe, expect, it } from "vitest";

import type { ToolDefinition } from "../types/tools.js";
import { resolveToolExecution, ToolRegistry } from "./tool-registry.js";

function testTool(execution?: ToolDefinition["execution"]): ToolDefinition {
  return {
    name: "PluginTool",
    description: "test",
    inputSchema: {},
    ...(execution ? { execution } : {}),
    async execute() {
      return { content: [] };
    },
  };
}

describe("tool execution domains", () => {
  it("defaults undeclared tools to local-only environment work", () => {
    expect(resolveToolExecution(testTool())).toEqual({
      domain: "environment",
      supportedEnvironments: ["local"],
    });
  });

  it("preserves an explicit execution contract in registry descriptors", () => {
    const registry = new ToolRegistry();
    registry.register(testTool({
      domain: "control_plane",
      supportedEnvironments: ["local", "docker"],
      network: true,
    }));

    expect(registry.getAll()[0]?.execution).toEqual({
      domain: "control_plane",
      supportedEnvironments: ["local", "docker"],
      network: true,
    });
  });
});
