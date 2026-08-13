import { describe, expect, it, vi } from "vitest";

import { mcpAuthTool } from "../index.js";

function textOf(result: Awaited<ReturnType<typeof mcpAuthTool.execute>>): string {
  return result.content.map((block) => block.type === "text" ? block.text : "").join("\n");
}

describe("McpAuth", () => {
  it("does not claim success when the host cannot save and reconnect MCP auth", async () => {
    const result = await mcpAuthTool.execute({
      serverName: "remote",
      mode: "bearer",
      value: "tok",
    }, { cwd: process.cwd() });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("No auth was saved");
  });

  it("delegates auth updates to the host effect", async () => {
    const configure = vi.fn(async () => ({ message: "saved and reconnected" }));

    const result = await mcpAuthTool.execute({
      serverName: "remote",
      mode: "header",
      key: "X-API-Key",
      value: "secret",
    }, {
      cwd: process.cwd(),
      mcpAuth: { configure },
    });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe("saved and reconnected");
    expect(configure).toHaveBeenCalledWith({
      serverName: "remote",
      mode: "header",
      key: "X-API-Key",
      value: "secret",
    });
  });

  it("returns host failures to the model", async () => {
    const result = await mcpAuthTool.execute({
      serverName: "remote",
      mode: "env",
      value: "secret",
    }, {
      cwd: process.cwd(),
      mcpAuth: {
        configure: async () => {
          throw new Error("env only works for stdio");
        },
      },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("env only works for stdio");
  });
});
