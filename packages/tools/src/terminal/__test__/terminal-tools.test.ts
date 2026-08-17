import type { ToolContext } from "@openharness/core";
import type {
  AgentTerminalHost,
  TerminalSessionInfo,
} from "@openharness/terminal";
import { describe, expect, it, vi } from "vitest";

import {
  terminalOpenTool,
} from "../terminal-tools.js";

const terminal: TerminalSessionInfo = {
  id: "terminal-1",
  name: "dev server",
  projectId: "project-1",
  runtime: "local",
  source: "agent",
  sessionId: "session-1",
  status: "running",
  cwd: "D:\\code\\project",
  shell: "powershell.exe",
  cols: 100,
  rows: 30,
  createdAt: "2026-08-15T00:00:00.000Z",
};

describe("persistent terminal tools", () => {
  it("opens a terminal scoped to the current durable session and cwd", async () => {
    const open = vi.fn(async () => terminal);
    const context = createContext({ open });

    const result = await terminalOpenTool.execute(
      { name: "dev server" },
      context,
    );

    expect(open).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: "D:\\code\\project",
      name: "dev server",
      cols: undefined,
      rows: undefined,
      shell: undefined,
    });
    expect(parseResult(result)).toMatchObject({
      kind: "terminal",
      action: "open",
      terminal: { id: "terminal-1" },
    });
  });

  it("fails before touching the host when no durable session exists", async () => {
    const open = vi.fn(async () => terminal);
    const result = await terminalOpenTool.execute(
      {},
      {
        cwd: terminal.cwd,
        terminal: createHost({ open }),
      },
    );

    expect(result.isError).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });
});

function createContext(overrides: Partial<AgentTerminalHost>): ToolContext {
  return {
    cwd: terminal.cwd,
    sessionId: "session-1",
    terminal: createHost(overrides),
  };
}

function createHost(overrides: Partial<AgentTerminalHost>): AgentTerminalHost {
  return {
    open: async () => terminal,
    ...overrides,
  };
}

function parseResult(
  result: Awaited<ReturnType<typeof terminalOpenTool.execute>>,
): Record<string, unknown> {
  const block = result.content[0];
  if (!block || block.type !== "text")
    throw new Error("Expected a text tool result");
  return JSON.parse(block.text) as Record<string, unknown>;
}
