import { describe, expect, it } from "vitest";
import {
  assertNoRemovedLifecycleToolNames,
  normalizeToolName,
  normalizeToolNames,
  resolveAllowedToolNames,
} from "./tool-names.js";

describe("tool name normalization", () => {
  it("converts Python-style tool names to TS runtime names", () => {
    expect(normalizeToolNames([
      "agent",
      "job_list",
      "job_read",
      "job_wait",
      "job_send",
      "job_cancel",
      "file_edit",
      "file_write",
      "notebook_edit",
      "exit_plan_mode",
      "web_fetch",
    ])).toEqual([
      "Agent",
      "JobList",
      "JobRead",
      "JobWait",
      "JobSend",
      "JobCancel",
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
