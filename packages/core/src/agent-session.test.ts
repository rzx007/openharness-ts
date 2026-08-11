import { describe, expect, it, vi } from "vitest";

import { createAgentSession } from "./agent-session.js";
import type { AgentExecutionContext, QueryEngine, StreamEvent } from "./index.js";

function createQueryEngine(submit: QueryEngine["submitMessage"]): QueryEngine {
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
  it("is a thin stateful QueryEngine wrapper", async () => {
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "hello" },
      { type: "complete", stopReason: "end_turn" },
    ];
    const execution = {} as AgentExecutionContext;
    const submit = vi.fn(async function* () {
      for (const event of events) yield event;
    });
    const engine = createQueryEngine(submit);
    const session = createAgentSession({ queryEngine: engine, sessionId: "s1" });

    const received: StreamEvent[] = [];
    for await (const event of session.submitMessage("hi", { execution })) received.push(event);

    expect(received).toEqual(events);
    expect(submit).toHaveBeenCalledWith("hi", { execution });
    expect(engine.setSessionId).toHaveBeenCalledWith("s1");
    expect(session.getHistory()).toEqual([{ type: "user", content: "hi" }]);
  });
});
