import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileEditTool } from "../edit.js";

describe("fileEditTool", () => {
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
