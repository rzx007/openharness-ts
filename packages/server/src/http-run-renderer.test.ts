import { describe, expect, it, vi } from "vitest";

import { SessionRunRenderer } from "./http-run-renderer.js";

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

describe("SessionRunRenderer", () => {
  it("projects text deltas into live message-part events", () => {
    const store = createStore();
    const renderer = new SessionRunRenderer(store);
    const state = renderer.createState("s1", "i1", "r1", "hello");

    const applied = renderer.applyStreamEvent(state, { type: "text_delta", delta: "world" });

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
    const renderer = new SessionRunRenderer(store);
    const state = renderer.createState("s1", "i1", "r1", "hello");

    renderer.applyStreamEvent(state, {
      type: "tool_use_start",
      toolUse: { id: "tool-1", name: "shell", input: { cmd: "pwd" } },
    });
    const applied = renderer.applyStreamEvent(state, {
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
});
