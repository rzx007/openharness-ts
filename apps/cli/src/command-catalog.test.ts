import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Settings } from "@openharness/core";

import { createCliCommandCatalog } from "./command-catalog.js";

function minimalSettings(): Settings {
  return {
    model: "m",
    apiFormat: "anthropic",
    maxTurns: 32,
    permission: { mode: "default" },
  };
}

describe("createCliCommandCatalog", () => {
  it("lists bundled user-invocable skills as template commands and expands them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ohs-catalog-"));
    try {
      const catalog = createCliCommandCatalog(minimalSettings());
      const commands = await catalog.list({ cwd: dir });
      expect(commands.map((command) => command.name)).toEqual(
        expect.arrayContaining(["/commit", "/review", "/plan"]),
      );
      expect(commands.every((command) => command.kind === "template")).toBe(true);

      const expanded = await catalog.expand!({ cwd: dir, name: "/commit", args: "fix auth" });
      expect(expanded?.command.name).toBe("/commit");
      expect(expanded?.prompt).toContain("## Arguments");
      expect(expanded?.prompt).toContain("fix auth");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("includes project skills from cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ohs-catalog-project-"));
    try {
      const skillDir = join(dir, ".openharness", "skills");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "ship.md"),
        "---\nname: ship\ndescription: Ship it\nuser-invocable: true\n---\nShip the change.\n",
      );
      const catalog = createCliCommandCatalog(minimalSettings());
      const commands = await catalog.list({ cwd: dir });
      expect(commands.find((command) => command.name === "/ship")).toMatchObject({
        kind: "template",
        source: "project",
        description: "Ship it",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
