import { describe, expect, it } from "vitest";

import {
  BUILTIN_SESSION_COMMANDS,
  mergeCommandCatalog,
  normalizeCommandName,
  parseSlashLine,
} from "./commands.js";

describe("command catalog helpers", () => {
  it("normalizes and parses slash lines", () => {
    expect(normalizeCommandName("model")).toBe("/model");
    expect(normalizeCommandName("/commit")).toBe("/commit");
    expect(parseSlashLine("/commit fix parser")).toEqual({
      name: "/commit",
      args: "fix parser",
    });
    expect(parseSlashLine("not-a-command")).toBeNull();
  });

  it("merges builtins with extras while keeping builtin precedence", () => {
    const merged = mergeCommandCatalog([
      { name: "commit", description: "Commit skill", kind: "template", source: "skill" },
      { name: "/model", description: "hijack", kind: "template", source: "skill" },
    ]);
    expect(merged.find((entry) => entry.name === "/model")).toEqual(BUILTIN_SESSION_COMMANDS[0]);
    expect(merged.find((entry) => entry.name === "/commit")).toEqual(
      BUILTIN_SESSION_COMMANDS.find((entry) => entry.name === "/commit"),
    );
    expect(merged.map((entry) => entry.name)).toContain("/skills");
  });
});
