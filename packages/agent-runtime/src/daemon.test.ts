import { describe, expect, it, vi } from "vitest";
import {
  AgentSessionRuntime,
  coreMessagesToTranscript,
  transcriptToCoreMessages,
} from "./daemon.js";

describe("AgentSessionRuntime cancellation", () => {
  it("passes the run signal and host to the agent", async () => {
    const submitMessage = vi.fn(async function* () {});
    const agent = {
      submitMessage,
      runtime: { queryEngine: {
        setModel: vi.fn(),
      } },
    };
    const runtime = new AgentSessionRuntime(
      agent as any,
      process.cwd(),
      () => ({} as any),
    );
    const controller = new AbortController();
    const host = {
      requestPermission: vi.fn(),
      emitEvent: vi.fn(),
      emitStreamEvent: vi.fn(),
    };

    await runtime.runPrompt(
      {
        session: { model: undefined },
        input: { content: "hello" },
        signal: controller.signal,
        wakeCount: () => 0,
        drainSteeredInputs: () => [],
      } as any,
      host as any,
    );

    expect(submitMessage).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({
        signal: controller.signal,
        pullFollowUps: expect.any(Function),
        host,
      }),
    );
  });

  it("drains steered inputs when wakeCount increases at turn boundaries", async () => {
    let pullFollowUps: (() => string[]) | undefined;
    const submitMessage = vi.fn(async function* (
      _content: string,
      options: { pullFollowUps?: () => string[] },
    ) {
      pullFollowUps = options.pullFollowUps;
    });
    const agent = {
      submitMessage,
      runtime: { queryEngine: {
      submitMessage,
      setModel: vi.fn(),
      } },
    };
    const runtime = new AgentSessionRuntime(
      agent as any,
      process.cwd(),
      () => ({} as any),
    );

    let wake = 0;
    const drainSteeredInputs = vi.fn(() => [{ content: "course correct" }]);
    await runtime.runPrompt(
      {
        session: { model: undefined },
        input: { content: "hello" },
        signal: new AbortController().signal,
        wakeCount: () => wake,
        drainSteeredInputs,
      } as any,
      {
        requestPermission: vi.fn(),
        emitEvent: vi.fn(),
        emitStreamEvent: vi.fn(),
      } as any,
    );

    expect(pullFollowUps?.()).toEqual([]);
    wake = 1;
    expect(pullFollowUps?.()).toEqual(["course correct"]);
    expect(drainSteeredInputs).toHaveBeenCalledTimes(1);
    expect(pullFollowUps?.()).toEqual([]);
  });
});

describe("daemon transcript codec", () => {
  it("preserves assistant tool calls and results", () => {
    const coreMessages = transcriptToCoreMessages(
      [{
        id: "message-1",
        sessionId: "session-1",
        seq: 1,
        role: "assistant",
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      }],
      [{
        id: "part-1",
        sessionId: "session-1",
        messageId: "message-1",
        seq: 1,
        type: "tool",
        status: "completed",
        toolUseId: "tool-1",
        toolName: "Read",
        input: { file_path: "README.md" },
        output: { content: [{ type: "text", text: "hello" }] },
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      }],
    );

    expect(coreMessages).toEqual([
      {
        type: "assistant",
        content: "",
        toolUses: [{
          type: "tool_use",
          id: "tool-1",
          name: "Read",
          input: { file_path: "README.md" },
        }],
      },
      {
        type: "tool_result",
        toolUseId: "tool-1",
        content: [{ type: "text", text: "hello" }],
        isError: false,
      },
    ]);

    expect(coreMessagesToTranscript(coreMessages)).toEqual([
      {
        role: "assistant",
        parts: [{
          type: "tool",
          status: "completed",
          toolUseId: "tool-1",
          toolName: "Read",
          input: { file_path: "README.md" },
          output: { content: [{ type: "text", text: "hello" }] },
          isError: false,
        }],
      },
    ]);
  });
});
