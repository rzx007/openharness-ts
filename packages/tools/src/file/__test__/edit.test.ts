import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileEditTool } from "../edit.js";

describe("fileEditTool", () => {
  it("reports the line of every ambiguous match", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-edit-matches-"));
    try {
      const file = join(dir, "repeated.txt");
      await writeFile(file, "same\nother\nsame\nsame\n", "utf-8");

      const result = await fileEditTool.execute!(
        { file_path: file, old_string: "same", new_string: "new" },
        {
          cwd: dir,
          settings: {
            model: "m",
            apiFormat: "openai",
            maxTurns: 1,
            permission: { mode: "default" },
            sandbox: { enabled: false },
          },
        },
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as { type: "text"; text: string }).text)
        .toBe("Found 3 matches at lines 1, 3, 4. Make old_string more specific or use replace_all to replace all.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects edits when sandbox read access is denied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-edit-sandbox-"));
    try {
      const file = join(dir, "secret.txt");
      await writeFile(file, "old", "utf-8");

      const result = await fileEditTool.execute!(
        { file_path: file, old_string: "old", new_string: "new" },
        {
          cwd: dir,
          settings: {
            model: "m",
            apiFormat: "openai",
            maxTurns: 1,
            permission: { mode: "default" },
            sandbox: {
              enabled: true,
              filesystem: {
                allowRead: ["."],
                denyRead: ["secret.txt"],
                allowWrite: ["."],
              },
            },
          },
        },
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("denied by sandbox rule");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
