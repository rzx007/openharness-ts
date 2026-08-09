import { describe, expect, it, vi } from "vitest";

import { createAgentSession } from "./agent-session.js";
import type { QueryEngine, StreamEvent } from "./index.js";

function createQueryEngine(
  submit: QueryEngine["submitMessage"],
): QueryEngine {
  return {
    submitMessage: submit,
    getHistory: vi.fn(() => [{ type: "user", content: "hi" }]),
    compact: vi.fn(),
    clear: vi.fn(),
    setSystemPrompt: vi.fn(),
    setApiClient: vi.fn(),
    setModel: vi.fn(),
    setMaxTurns: vi.fn(),
    loadMessages: vi.fn(),
    getTotalUsage: vi.fn(() => ({ inputTokens: 0, outputTokens: 0 })),
    setMemoryRetriever: vi.fn(),
    setAttachmentsProvider: vi.fn(),
    setAllowedTools: vi.fn(),
    setSessionId: vi.fn(),
    setMcpManager: vi.fn(),
  };
}

describe("AgentSession", () => {
  it("runs a message through QueryEngine and forwards stream events to the host callback", async () => {
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "hello" },
      { type: "text_delta", delta: " world" },
      { type: "complete", stopReason: "end_turn" },
    ];
    const onStream = vi.fn();
    const engine = createQueryEngine(async function* () {
      for (const event of events) yield event;
    });
    const session = createAgentSession({
      queryEngine: engine,
      cwd: "/repo",
      sessionId: "s1",
      emitStreamEvent: onStream,
    });

    const result = await session.runMessage("hi");

    expect(result.output).toBe("hello world");
    expect(result.events).toEqual(events);
    expect(onStream).toHaveBeenCalledTimes(3);
    expect(engine.setSessionId).toHaveBeenCalledWith("s1");
  });

  it("provides a run-scoped host with permission callback support", async () => {
    const requestPermission = vi.fn(async () => ({ status: "approved" as const, decision: "once" as const }));
    const engine = createQueryEngine(async function* (_content, options) {
      const decision = await options?.runtimeHost?.requestPermission({
        toolName: "Write",
        input: { file: "a.txt" },
      });
      yield { type: "text_delta", delta: decision?.status ?? "missing" };
    });
    const session = createAgentSession({
      queryEngine: engine,
      cwd: "/repo",
      sessionId: "s1",
      requestPermission,
    });

    const result = await session.runMessage("edit");

    expect(result.output).toBe("approved");
    expect(requestPermission).toHaveBeenCalledWith({ toolName: "Write", input: { file: "a.txt" } });
  });

  it("denies permissions without requiring child-agent capabilities", async () => {
    const engine = createQueryEngine(async function* (_content, options) {
      const decision = await options?.runtimeHost?.requestPermission({ toolName: "Bash" });
      yield { type: "text_delta", delta: decision?.status ?? "missing" };
    });
    const session = createAgentSession({ queryEngine: engine, cwd: "/repo" });

    const result = await session.runMessage("run");

    expect(result.output).toBe("denied");
    expect(session.createHost().childAgentHost).toBeUndefined();
  });
});
