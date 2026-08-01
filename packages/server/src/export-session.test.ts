import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { writeSessionExport } from "./export-session.js";

describe("writeSessionExport", () => {
  it("writes markdown and json exports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oh-export-"));
    try {
      const session = {
        id: "s1",
        cwd: process.cwd(),
        title: "t",
        model: "m",
        status: "idle" as const,
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      };
      const messages = [{
        id: "m1",
        sessionId: "s1",
        seq: 1,
        role: "user" as const,
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      }];
      const parts = [{
        id: "p1",
        sessionId: "s1",
        messageId: "m1",
        seq: 1,
        type: "text" as const,
        status: "completed" as const,
        text: "hello export",
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      }];

      const md = await writeSessionExport({
        session,
        messages,
        parts,
        format: "md",
        filename: join(dir, "out.md"),
      });
      expect(readFileSync(md.filepath, "utf8")).toContain("hello export");

      const json = await writeSessionExport({
        session,
        messages,
        parts,
        format: "json",
        filename: join(dir, "out.json"),
      });
      const parsed = JSON.parse(readFileSync(json.filepath, "utf8")) as {
        message_count: number;
        messages: Array<{ content: string }>;
      };
      expect(parsed.message_count).toBe(1);
      expect(parsed.messages[0]?.content).toBe("hello export");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
