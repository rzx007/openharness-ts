import { describe, expect, it } from "vitest";
import {
  assertNoRemovedLifecycleToolNames,
  normalizeToolName,
  normalizeToolNames,
  resolveAllowedToolNames,
} from "./tool-names.js";

describe("tool name normalization", () => {
  it("keeps tool names exact", () => {
    expect(normalizeToolNames(["Agent", "JobList", "Edit"]))
      .toEqual(["Agent", "JobList", "Edit"]);
  });

  it("does not repair case and preserves dynamic names", () => {
    expect(normalizeToolName("mcp__Github__Search", ["mcp__github__search"]))
      .toBe("mcp__Github__Search");
    expect(normalizeToolName("CustomPluginTool", ["Bash", "Read"]))
      .toBe("CustomPluginTool");
  });

  it("deduplicates normalized names and treats '*' as an unrestricted allowlist", () => {
    expect(normalizeToolNames(["Bash", "Bash", "Edit", "Edit"]))
      .toEqual(["Bash", "Edit"]);
    expect(resolveAllowedToolNames(["JobWait", "*", "Read"]))
      .toEqual([]);
  });

  it("does not translate removed Task control aliases", () => {
    expect(normalizeToolNames(["task_wait", "task_output", "send_message"]))
      .toEqual(["task_wait", "task_output", "send_message"]);
  });

  it("reports removed lifecycle tools without rejecting dynamic plugin names", () => {
    expect(() => assertNoRemovedLifecycleToolNames(
      ["DynamicPluginTool", "TaskWait", "terminal_send", "TaskUpdate"],
      "configuration.allowedTools",
    )).toThrow(
      'configuration.allowedTools contains removed lifecycle tool names: "TaskWait" -> "JobWait", "terminal_send" -> "JobSend", "TaskUpdate" (remove it; no Job equivalent). Compatibility aliases are not supported.',
    );
    expect(() => assertNoRemovedLifecycleToolNames(
      ["DynamicPluginTool"],
      "configuration.allowedTools",
    )).not.toThrow();
  });
});
