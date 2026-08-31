import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fileEditTool } from "../edit.js";
import { ManagedResourcePolicy } from "../managed-resource-policy.js";
import { fileWriteTool } from "../write.js";

describe("ManagedResourcePolicy", () => {
  it("blocks Write and Edit for managed directories and files without exposing their paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "managed-resource-"));
    const contextRoot = join(root, ".openharness-ts", "context");
    const soul = join(root, ".openharness-ts", "SOUL.md");
    const policy = new ManagedResourcePolicy({ directories: [contextRoot], files: [soul] });
    const context = { cwd: root, managedResources: policy };
    const write = await fileWriteTool.execute!({ file_path: join(contextRoot, "projects", "p", "rules.md"), content: "bad" }, context);
    await mkdir(join(root, ".openharness-ts"), { recursive: true });
    await writeFile(soul, "old", "utf8");
    const edit = await fileEditTool.execute!({ file_path: soul, old_string: "old", new_string: "bad" }, context);
    expect(write).toMatchObject({ isError: true, failureKind: "policy" });
    expect(edit).toMatchObject({ isError: true, failureKind: "policy" });
    expect(JSON.stringify([write, edit])).not.toContain(root);
    expect(await readFile(soul, "utf8")).toBe("old");
  });

  it("normalizes traversal, separators, and case while leaving ordinary workspace files writable", async () => {
    const root = await mkdtemp(join(tmpdir(), "managed-resource-"));
    const managed = join(root, "State", "Context");
    const policy = new ManagedResourcePolicy({ directories: [managed] });
    expect(policy.check(join(root, "State", "other", "..", "Context", "rules.md"), "write").allowed).toBe(false);
    expect(policy.check(managed.toUpperCase().replaceAll("/", "\\") + "\\rules.md", "edit").allowed).toBe(false);
    const normal = join(root, "src", "app.ts");
    const result = await fileWriteTool.execute!({ file_path: normal, content: "ok" }, { cwd: root, managedResources: policy });
    expect(result.isError).toBeFalsy();
    expect(await readFile(normal, "utf8")).toBe("ok");
  });
});
