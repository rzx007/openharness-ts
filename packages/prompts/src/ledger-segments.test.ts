import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPromptLedgerSegments } from "./ledger-segments.js";

describe("buildPromptLedgerSegments", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "oh-ledger-segments-"));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("tags skills catalog as skills and delegation as subagents", async () => {
    const segments = await buildPromptLedgerSegments({
      cwd: tmpDir,
      includeDelegation: true,
      skillsList: [{ name: "foo", description: "bar" }],
    });
    expect(segments.some((s) => s.bucket === "skills" && s.text.includes("foo"))).toBe(true);
    expect(segments.some((s) => s.bucket === "subagents")).toBe(true);
    expect(segments.some((s) => s.bucket === "system")).toBe(true);
  });

  it("does not put full memory preview into segments by default", async () => {
    const segments = await buildPromptLedgerSegments({ cwd: tmpDir });
    expect(segments.every((s) => s.bucket !== "conversation")).toBe(true);
  });

  it("excludes memoryContent from segments even when provided", async () => {
    const segments = await buildPromptLedgerSegments({
      cwd: tmpDir,
      memoryContent: "remember this secret preview",
    });
    expect(segments.every((s) => !s.text.includes("remember this secret preview"))).toBe(true);
    expect(segments.every((s) => s.bucket !== "conversation")).toBe(true);
  });

  it("maps memoryReminderText to conversation bucket", async () => {
    const segments = await buildPromptLedgerSegments({
      cwd: tmpDir,
      memoryReminderText: "Relevant memory: user prefers TypeScript.",
    });
    expect(segments.some((s) => s.bucket === "conversation" && s.text.includes("TypeScript"))).toBe(
      true,
    );
  });
});
