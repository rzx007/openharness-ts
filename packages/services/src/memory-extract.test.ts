import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { MemoryManager } from "@openharness/memory";
import type { StreamEvent, StreamingMessageClient } from "@openharness/core";
import {
  hasMemoryWritesSince,
  buildExtractionPrompt,
  parseExtractionRecords,
  extractMemoriesFromTurn,
  EXTRACTION_SYSTEM_PROMPT,
} from "./memory-extract.js";

const MEMORY_DIR = join("/proj", ".openharness", "memory");

function fakeClient(responseText: string): StreamingMessageClient {
  return {
    async *streamMessage(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", delta: responseText.slice(0, 5) };
      yield { type: "text_delta", delta: responseText.slice(5) };
      yield { type: "complete", stopReason: "end_turn" };
    },
  };
}

describe("hasMemoryWritesSince", () => {
  it("detects Write/Edit tool calls targeting the memory dir (abs and relative)", () => {
    const inDir = [
      { role: "assistant", content: [{ type: "tool_use", name: "Write", input: { file_path: join(MEMORY_DIR, "a.md") } }] },
    ];
    expect(hasMemoryWritesSince(inDir, MEMORY_DIR)).toBe(true);

    const relative = [
      { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { path: join(".openharness", "memory", "b.md") } }] },
    ];
    expect(hasMemoryWritesSince(relative, MEMORY_DIR, "/proj")).toBe(true);
  });

  it("ignores writes elsewhere and non-write tools", () => {
    const elsewhere = [
      { role: "assistant", content: [{ type: "tool_use", name: "Write", input: { file_path: "/proj/src/x.ts" } }] },
      { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: join(MEMORY_DIR, "a.md") } }] },
    ];
    expect(hasMemoryWritesSince(elsewhere, MEMORY_DIR)).toBe(false);
  });
});

describe("buildExtractionPrompt / parseExtractionRecords", () => {
  it("includes manifest, transcript, and the JSON schema", () => {
    const prompt = buildExtractionPrompt("- existing-memory", [{ role: "user", content: "remember the staging IP" }]);
    expect(prompt).toContain("- existing-memory");
    expect(prompt).toContain("user: remember the staging IP");
    expect(prompt).toContain('"memories"');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("Do not save secrets");
  });

  it("parses records with type/scope fallback, tolerates noise text and bad JSON", () => {
    const records = parseExtractionRecords(
      'Here you go:\n{"memories":[{"title":"Staging IP","body":"10.0.0.7","type":"reference","scope":"project","tags":["infra"]},{"title":"","body":"dropped"},{"title":"NoBody"}]}\nThanks!',
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.title).toBe("Staging IP");
    expect(records[0]!.memoryType).toBe("reference");
    expect(records[0]!.tags).toEqual(["infra"]);

    expect(parseExtractionRecords("not json at all")).toEqual([]);
    expect(parseExtractionRecords('{"memories": "wrong shape"}')).toEqual([]);
  });

  it("caps records at maxRecords", () => {
    const many = JSON.stringify({
      memories: Array.from({ length: 5 }, (_, i) => ({ title: `t${i}`, body: `b${i}` })),
    });
    expect(parseExtractionRecords(many, 2)).toHaveLength(2);
  });
});

describe("extractMemoriesFromTurn", () => {
  const messages = [
    { role: "user", content: "the staging server is 10.0.0.7" },
    { role: "assistant", content: "noted" },
  ];

  it("writes parsed records into the MemoryManager", async () => {
    const manager = new MemoryManager(100);
    const result = await extractMemoriesFromTurn({
      apiClient: fakeClient('{"memories":[{"title":"Staging IP","body":"Staging server is 10.0.0.7","type":"reference"}]}'),
      model: "test-model",
      messages,
      manager,
    });
    expect(result.skipped).toBe(false);
    expect(result.writtenIds).toHaveLength(1);
    const entries = await manager.getAll();
    expect(entries.some((e) => e.content.includes("10.0.0.7"))).toBe(true);
  });

  it("skips: not enough messages / already wrote memory / nothing proposed / team scope", async () => {
    const manager = new MemoryManager(100);
    expect(
      (await extractMemoriesFromTurn({ apiClient: fakeClient("{}"), model: "m", messages: [messages[0]!], manager })).reason,
    ).toBe("not enough messages");

    const wrote = [
      ...messages,
      { role: "assistant", content: [{ type: "tool_use", name: "Write", input: { file_path: join(MEMORY_DIR, "x.md") } }] },
    ];
    expect(
      (
        await extractMemoriesFromTurn({
          apiClient: fakeClient("{}"),
          model: "m",
          messages: wrote,
          manager,
          memoryDir: MEMORY_DIR,
        })
      ).reason,
    ).toBe("main conversation already wrote memory");

    expect(
      (await extractMemoriesFromTurn({ apiClient: fakeClient('{"memories":[]}'), model: "m", messages, manager })).reason,
    ).toBe("no durable memories proposed");

    const teamOnly = await extractMemoriesFromTurn({
      apiClient: fakeClient('{"memories":[{"title":"T","body":"B","scope":"team"}]}'),
      model: "m",
      messages,
      manager,
    });
    expect(teamOnly.skipped).toBe(true);
    expect(teamOnly.reason).toBe("all records rejected");
  });
});
