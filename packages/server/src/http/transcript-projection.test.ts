import { describe, expect, it, vi } from "vitest";

import { SessionTranscriptProjection } from "./transcript-projection.js";

function createStore() {
  let messageSeq = 0;
  let partSeq = 0;
  return {
    appendMessagePartDelta: vi.fn((input) => ({
      id: "e1",
      seq: 1,
      type: "session.message_part.delta",
      sessionId: input.sessionId,
      payload: input,
      createdAt: 1,
    })),
    createMessage: vi.fn((input) => ({
      id: `m${++messageSeq}`,
      seq: messageSeq,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
      ...input,
    })),
    listMessages: vi.fn(() => []),
    listMessageParts: vi.fn(() => []),
    updateRun: vi.fn(),
    upsertMessagePart: vi.fn((input) => ({
      id: input.id ?? `p${++partSeq}`,
      seq: partSeq,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
      ...input,
    })),
  };
}

describe("SessionTranscriptProjection", () => {
  it("projects text deltas into live message-part events", () => {
    const store = createStore();
    const projection = new SessionTranscriptProjection(store);
    const state = projection.beginRun("s1", "i1", "r1", "hello");

    const applied = projection.projectStreamEvent(state, { type: "text_delta", delta: "world" });

    expect(store.createMessage).toHaveBeenCalledWith({
      sessionId: "s1",
      role: "user",
      runId: "r1",
      inputId: "i1",
    });
    expect(applied.liveEvent).toMatchObject({
      type: "session.message_part.delta",
      sessionId: "s1",
    });
    expect(store.appendMessagePartDelta).toHaveBeenCalledWith({
      sessionId: "s1",
      messageId: "m2",
      partId: "p2",
      field: "text",
      delta: "world",
    });
  });

  it("keeps tool names available when completing tool parts", () => {
    const store = createStore();
    const projection = new SessionTranscriptProjection(store);
    const state = projection.beginRun("s1", "i1", "r1", "hello");

    projection.projectStreamEvent(state, {
      type: "tool_use_start",
      toolUse: { id: "tool-1", name: "shell", input: { cmd: "pwd" } },
    });
    const applied = projection.projectStreamEvent(state, {
      type: "tool_use_end",
      toolUseId: "tool-1",
      result: { output: "ok", isError: false },
    });

    expect(applied.completedToolName).toBe("shell");
    expect(store.upsertMessagePart).toHaveBeenLastCalledWith({
      id: "tool-1",
      sessionId: "s1",
      messageId: "m2",
      type: "tool",
      status: "completed",
      toolUseId: "tool-1",
      toolName: "shell",
      input: { cmd: "pwd" },
      output: { output: "ok", isError: false },
      isError: false,
    });
  });

  it("closes only running parts owned by the failed run", () => {
    const store = createStore();
    store.listMessages.mockReturnValue([
      { id: "m1", runId: "r1" },
      { id: "m2", runId: "r2" },
    ] as any);
    store.listMessageParts.mockReturnValue([
      { id: "p1", messageId: "m1", type: "text", status: "running" },
      { id: "p2", messageId: "m1", type: "tool", status: "completed" },
      { id: "p3", messageId: "m2", type: "text", status: "running" },
    ] as any);
    const projection = new SessionTranscriptProjection(store);

    projection.finalizeRunParts("s1", "r1", "failed");

    expect(store.upsertMessagePart).toHaveBeenCalledOnce();
    expect(store.upsertMessagePart).toHaveBeenCalledWith({
      id: "p1",
      sessionId: "s1",
      messageId: "m1",
      type: "text",
      status: "failed",
    });
  });

  it("does not duplicate a steered user message when projection is retried", () => {
    const store = createStore();
    store.listMessages
      .mockReturnValueOnce([])
      .mockReturnValue([{ id: "m-steer", inputId: "steer-1" }] as any);
    const projection = new SessionTranscriptProjection(store);
    const state = {
      sessionId: "s1",
      runId: "r1",
      inputId: "i1",
      assistantTurnCompleted: false,
      toolParts: new Map(),
    };
    const input = {
      id: "steer-1",
      sessionId: "s1",
      seq: 2,
      delivery: "steer" as const,
      content: "continue",
      metadata: {},
      createdAt: 1,
    };

    projection.projectSteeredInputs(state, [input]);
    projection.projectSteeredInputs(state, [input]);

    expect(store.createMessage).toHaveBeenCalledOnce();
  });
});
