import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ContextBackupService } from "../context-backup.js";
import { ContextPaths } from "../context-paths.js";

describe("ContextBackupService", () => {
  it("backs up only named managed topic documents and restores them by backup id", async () => {
    const root = await mkdtemp(join(tmpdir(), "context-backup-"));
    const paths = new ContextPaths(root);
    const ref = { scope: "project" as const, scopeKey: "project-1", topic: "rules" as const };
    const source = paths.documentFor(ref);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, "projects", "project-1"), { recursive: true }));
    await writeFile(source, "before", "utf8");

    const backups = new ContextBackupService({ root });
    const backup = await backups.create([ref]);
    await writeFile(source, "after", "utf8");
    await backups.restore(backup.id);

    expect(await readFile(source, "utf8")).toBe("before");
    expect(backup.documents).toEqual([{ scope: "project", scopeKey: "project-1", topic: "rules" }]);
    expect(backup).not.toHaveProperty("path");
    expect(backup).not.toHaveProperty("directory");
  });
});
