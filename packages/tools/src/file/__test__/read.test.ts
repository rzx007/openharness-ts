import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fileReadTool } from "../read.js";

describe("fileReadTool", () => {
  it("reads an attachment URI through the session-scoped host", async () => {
    const readText = vi.fn(async () => ({
      displayName: "report.log",
      mediaType: "text/plain",
      encoding: "utf-8" as const,
      content: "two\nthree",
      startLine: 2,
      endLine: 3,
      hasMore: true,
    }));

    const result = await fileReadTool.execute!(
      { file_path: "attachment://att_123/report.log", offset: 2, limit: 2 },
      { cwd: "D:/project", sessionId: "session-1", attachments: { readText } },
    );

    expect(readText).toHaveBeenCalledWith(
      { assetId: "att_123", offset: 2, limit: 2 },
      expect.objectContaining({ sessionId: "session-1" }),
    );
    expect((result.content[0] as { text: string }).text).toBe(
      "2: two\n3: three\nhas_more: true",
    );
    expect(result.isError).toBeFalsy();
  });

  it.each([
    "attachment:///missing.txt",
    "attachment://user@att_123/report.log",
    "attachment://att_123:80/report.log",
    "attachment://att_123/report%2Fsecret.log",
    "attachment://att_123/report.log?raw=1",
    "attachment://att_123/report.log#part",
  ])("rejects malformed attachment URI %s", async (filePath) => {
    const result = await fileReadTool.execute!({ file_path: filePath }, { cwd: "D:/project" });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Invalid attachment URI");
  });

  it("returns a stable error when the attachment host is unavailable", async () => {
    const result = await fileReadTool.execute!(
      { file_path: "attachment://att_123/report.log" },
      { cwd: "D:/project" },
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(
      "Attachment resources are unavailable",
    );
  });

  it.each([
    [{ offset: 0 }, "offset"],
    [{ offset: 1.5 }, "offset"],
    [{ limit: 0 }, "limit"],
    [{ limit: 2001 }, "limit"],
  ])("rejects invalid attachment ranges", async (range, field) => {
    const result = await fileReadTool.execute!(
      { file_path: "attachment://att_123/report.log", ...range },
      { cwd: "D:/project", attachments: { readText: vi.fn() } },
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(field);
  });

  it("reads files with line numbers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-"));
    try {
      const file = join(dir, "notes.txt");
      await writeFile(file, "one\ntwo\nthree", "utf-8");

      const result = await fileReadTool.execute!(
        { file_path: file, offset: 2, limit: 1 },
        { cwd: dir }
      );

      expect((result.content[0] as any).text).toBe("2: two");
      expect(result.isError).toBeFalsy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lists directory entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-dir-"));
    try {
      await mkdir(join(dir, "app"));
      await writeFile(join(dir, "README.md"), "hello", "utf-8");

      const result = await fileReadTool.execute!(
        { file_path: dir },
        { cwd: dir }
      );

      const text = (result.content[0] as any).text as string;
      expect(text).toContain("app/");
      expect(text).toContain("README.md");
      expect(result.isError).toBeFalsy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects paths outside cwd when sandbox is enabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-sandbox-"));
    const outside = await mkdtemp(join(tmpdir(), "oh-read-outside-"));
    try {
      const file = join(outside, "secret.txt");
      await writeFile(file, "secret", "utf-8");

      const result = await fileReadTool.execute!(
        { file_path: file },
        {
          cwd: dir,
          settings: {
            model: "m",
            apiFormat: "openai",
            maxTurns: 1,
            permission: { mode: "default" },
            sandbox: { enabled: true },
          },
        },
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("outside the sandbox boundary");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
