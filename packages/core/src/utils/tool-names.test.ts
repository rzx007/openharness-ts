import { describe, expect, it } from "vitest";
import {
  normalizeToolName,
  normalizeToolNames,
  resolveAllowedToolNames,
} from "./tool-names.js";

describe("tool name normalization", () => {
  it("converts Python-style tool names to TS runtime names", () => {
    expect(normalizeToolNames([
      "agent",
      "send_message",
      "task_stop",
      "task_wait",
      "file_edit",
      "file_write",
      "notebook_edit",
      "exit_plan_mode",
      "web_fetch",
    ])).toEqual([
      "Agent",
      "SendMessage",
      "TaskStop",
      "TaskWait",
      "Edit",
      "Write",
      "NotebookEdit",
      "ExitPlanMode",
      "WebFetch",
    ]);
  });

  it("uses known tool names to repair case and preserve dynamic names", () => {
    expect(normalizeToolName("mcp__Github__Search", ["mcp__github__search"]))
      .toBe("mcp__github__search");
    expect(normalizeToolName("CustomPluginTool", ["Bash", "Read"]))
      .toBe("CustomPluginTool");
  });

  it("deduplicates normalized names and treats '*' as an unrestricted allowlist", () => {
    expect(normalizeToolNames(["bash", "Bash", "file_edit", "Edit"]))
      .toEqual(["Bash", "Edit"]);
    expect(resolveAllowedToolNames(["TaskWait", "*", "Read"]))
      .toEqual([]);
  });
});
