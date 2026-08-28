import { describe, expect, it } from "vitest";

import { agentMessagesToTranscript, buildAgentTranscript } from "../agent-transcript.js";

describe("agent transcript codec", () => {
  it("preserves assistant commentary and final-answer phases", () => {
    const transcript = buildAgentTranscript(
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
        type: "text",
        status: "completed",
        text: "I will inspect it.",
        metadata: { phase: "commentary" },
        createdAt: 1,
        updatedAt: 1,
      }],
    );

    expect(transcript.messages).toEqual([{
      type: "assistant",
      content: "I will inspect it.",
      phase: "commentary",
    }]);
    expect(agentMessagesToTranscript(transcript.messages)).toEqual([{
      role: "assistant",
      parts: [{
        type: "text",
        status: "completed",
        text: "I will inspect it.",
        metadata: { phase: "commentary" },
      }],
    }]);
  });

  it("preserves assistant tool calls and results", () => {
    const transcript = buildAgentTranscript(
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

    expect(agentMessagesToTranscript(transcript.messages)).toEqual([{
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

  it("keeps attachment metadata in a provider-safe sidecar", () => {
    const transcript = buildAgentTranscript(
      [{
        id: "m1",
        sessionId: "session-1",
        seq: 1,
        role: "user",
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      }],
      [
        {
          id: "part-text",
          sessionId: "session-1",
          messageId: "m1",
          seq: 1,
          type: "text",
          status: "completed",
          text: "inspect this",
          metadata: {},
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "part-attachment",
          sessionId: "session-1",
          messageId: "m1",
          seq: 2,
          type: "attachment",
          status: "completed",
          assetId: "att_1",
          intent: "vision",
          displayName: "screen.png",
          mediaType: "image/png",
          sizeBytes: 42,
          metadata: { inputAttachmentId: "ref_1", localPath: "never-send-this" },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    );

    expect(transcript).toEqual({
      messages: [{ type: "user", content: "inspect this" }],
      attachmentsByMessageId: {
        m1: [{
          assetId: "att_1",
          intent: "vision",
          displayName: "screen.png",
          mediaType: "image/png",
          sizeBytes: 42,
        }],
      },
    });
    expect(JSON.stringify(transcript.messages)).not.toContain("never-send-this");
    expect(JSON.stringify(transcript.messages)).not.toContain("att_1");
  });
});
