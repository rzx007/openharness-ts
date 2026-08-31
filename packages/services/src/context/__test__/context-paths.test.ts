import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ContextPaths } from "../context-paths.js";

describe("ContextPaths", () => {
  it("creates one stable machine id under concurrent first use", async () => {
    const root = await mkdtemp(join(tmpdir(), "openharness-context-paths-"));
    const paths = new ContextPaths(root);

    const ids = await Promise.all(Array.from({ length: 8 }, () => paths.getOrCreateMachineId()));

    expect(new Set(ids).size).toBe(1);
    expect((await readFile(join(root, ".machine-id"), "utf8")).trim()).toBe(ids[0]);
  });

  it("maps supported scopes and topics to fixed managed paths", () => {
    const root = join(tmpdir(), "openharness-context-root");
    const paths = new ContextPaths(root);

    expect(paths.directoryFor({ scope: "user", scopeKey: "local-user" })).toBe(join(root, "user"));
    expect(paths.directoryFor({ scope: "machine", scopeKey: "machine-1" })).toBe(join(root, "machine", "machine-1"));
    expect(paths.directoryFor({ scope: "project", scopeKey: "project-1" })).toBe(join(root, "projects", "project-1"));
    expect(paths.documentFor({ scope: "user", scopeKey: "local-user", topic: "ui-design" }))
      .toBe(join(root, "user", "ui-design.md"));
    expect(paths.documentFor({ scope: "project", scopeKey: "project-1", topic: "rules" }))
      .toBe(join(root, "projects", "project-1", "rules.md"));
  });

  it.each(["../outside", "..\\outside", "C:\\outside", "/outside", "project/child", ".", "..", ""])(
    "rejects unsafe scope key %s",
    (scopeKey) => {
      const paths = new ContextPaths(join(tmpdir(), "openharness-context-root"));
      expect(() => paths.directoryFor({ scope: "project", scopeKey })).toThrow(/invalid scope key/i);
    },
  );

  it("rejects topics that are not allowed for the scope", () => {
    const paths = new ContextPaths(join(tmpdir(), "openharness-context-root"));
    expect(() => paths.documentFor({ scope: "user", scopeKey: "local-user", topic: "rules" }))
      .toThrow(/invalid topic/i);
    expect(() => paths.documentFor({ scope: "machine", scopeKey: "machine-1", topic: "preferences" }))
      .toThrow(/invalid topic/i);
  });
});
