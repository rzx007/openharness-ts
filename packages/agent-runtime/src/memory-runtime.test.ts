import { join, resolve } from "node:path";

import type {
  Message,
  StreamEvent,
  StreamingMessageClient,
} from "@openharness/core";
import { MemoryManager } from "@openharness/memory";
import { describe, expect, it } from "vitest";

import { extractMemories } from "./memory-runtime.js";

const messages: Message[] = [
  { type: "user", content: "remember these durable facts" },
  { type: "assistant", content: "noted" },
];

function fakeClient(responseText: string, onStream?: () => void): StreamingMessageClient {
  return {
    async *streamMessage(): AsyncIterable<StreamEvent> {
      onStream?.();
      yield { type: "text_delta", delta: responseText.slice(0, 17) };
      yield { type: "text_delta", delta: responseText.slice(17) };
      yield { type: "complete", stopReason: "end_turn" };
    },
  };
}

describe("extractMemories", () => {
  it("uses the canonical defaults, team filter, and three-record cap", async () => {
    const response =
      "model preface\n" +
      JSON.stringify({
        memories: [
          { title: "Default", body: "default record", type: "unknown", scope: "unknown" },
          { title: "Team", body: "shared record", scope: "team" },
          { title: "Private", body: "private record", type: "reference", scope: "private" },
          { title: "Fourth", body: "must be capped" },
        ],
      }) +
      "\nmodel epilogue";
    const manager = new MemoryManager(100);

    const result = await extractMemories({
      apiClient: fakeClient(response),
      model: "test-model",
      messages,
      manager,
      memoryDir: resolve("memory"),
      cwd: resolve("project"),
    });

    expect(result).toMatchObject({
      skipped: false,
      titles: ["Default", "Private"],
    });
    const entries = await manager.getAll();
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => [entry.name, entry.type, entry.scope])).toEqual([
      ["Default", "project", "project"],
      ["Private", "reference", "private"],
    ]);
  });

  it("skips model streaming when an assistant already wrote inside the memory directory", async () => {
    const cwd = resolve("project");
    const memoryDir = join(cwd, ".openharness", "memory");
    const wroteMemory: Message[] = [
      messages[0]!,
      {
        type: "assistant",
        content: "saved directly",
        toolUses: [
          {
            type: "tool_use",
            id: "write-memory",
            name: "Write",
            input: { file_path: join(".openharness", "memory", "manual.md") },
          },
        ],
      },
    ];
    let streamCalls = 0;

    const result = await extractMemories({
      apiClient: fakeClient('{"memories":[]}', () => streamCalls++),
      model: "test-model",
      messages: wroteMemory,
      manager: new MemoryManager(100),
      memoryDir,
      cwd,
    });

    expect(result).toEqual({
      skipped: true,
      reason: "main conversation already wrote memory",
      writtenIds: [],
      titles: [],
    });
    expect(streamCalls).toBe(0);
  });
});
