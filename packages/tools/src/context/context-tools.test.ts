import type { AgentContextMemoryHost, ToolContext } from "@openharness/core";
import { describe, expect, it, vi } from "vitest";

import { contextMemoryTools } from "./context-tools.js";

function context(host?: AgentContextMemoryHost): ToolContext {
  return {
    cwd: "C:\\workspace\\project",
    sessionId: "session-1",
    contextMemory: host,
    agent: {
      scope: {
        agentId: "agent-1",
        sessionId: "session-1",
        runId: "run-1",
        inputId: "input-1",
        cwd: "C:\\workspace\\project",
        traceId: "trace-1",
        signal: new AbortController().signal,
      },
    } as ToolContext["agent"],
  };
}

describe("context memory tools", () => {
  it("passes durable run provenance to Remember", async () => {
    const remember = vi.fn(async () => ({ status: "completed", results: [{ status: "committed", id: "ctx-1" }] }));
    const host = { remember } as unknown as AgentContextMemoryHost;

    const result = await contextMemoryTools.find(({ name }) => name === "ContextRemember")!
      .execute({ content: "记住回答简洁" }, context(host));

    expect(remember).toHaveBeenCalledWith(
      { content: "记住回答简洁" },
      { sessionId: "session-1", runId: "run-1", inputId: "input-1", cwd: "C:\\workspace\\project", signal: expect.any(AbortSignal) },
    );
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("committed") });
    expect(JSON.stringify(result)).not.toMatch(/(?:directory|path)/i);
  });

  it.each([
    ["ContextRecall", "recall", { query: "项目规则" }],
    ["ContextResolve", "resolve", { id: "ctx-1", action: "accept", topic: "rules" }],
    ["ContextUpdate", "update", { id: "ctx-1", content: "改用 pnpm" }],
    ["ContextForget", "forget", { id: "ctx-1" }],
  ] as const)("delegates %s to its host method", async (toolName, method, input) => {
    const call = vi.fn(async () => ({ status: "completed" }));
    const host = { [method]: call } as unknown as AgentContextMemoryHost;

    await contextMemoryTools.find(({ name }) => name === toolName)!.execute(input, context(host));

    expect(call).toHaveBeenCalledWith(input, expect.objectContaining({ sessionId: "session-1", runId: "run-1" }));
  });

  it("fails safely if a tool is executed without its host capability", async () => {
    const result = await contextMemoryTools[0]!.execute({ content: "记住" }, context());
    expect(result).toMatchObject({ isError: true, failureKind: "policy" });
  });
});
