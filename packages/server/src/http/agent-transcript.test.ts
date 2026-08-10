import { describe, expect, it } from "vitest";

import { agentMessagesToTranscript, transcriptToAgentMessages } from "./agent-transcript.js";

describe("agent transcript codec", () => {
  it("preserves assistant tool calls and results", () => {
    const messages = transcriptToAgentMessages(
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

    expect(agentMessagesToTranscript(messages)).toEqual([{
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
    }]);
  });
});
