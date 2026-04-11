import { describe, it, expect } from "vitest";
import { createDefaultToolRegistry } from "./registry.js";

describe("createDefaultToolRegistry", () => {
  it("registers all built-in tools", () => {
    const registry = createDefaultToolRegistry();
    const tools = registry.getAll();
    const names = tools.map((t) => t.name);
    expect(names).toContain("Bash");
    expect(names).toContain("Read");
    expect(names).toContain("Write");
    expect(names).toContain("Edit");
    expect(names).toContain("Glob");
    expect(names).toContain("Grep");
    expect(names).toContain("WebFetch");
    expect(names).toContain("WebSearch");
    expect(names).toContain("TodoWrite");
    expect(names).toContain("Config");
    expect(names).toContain("Sleep");
    expect(names).toContain("Skill");
    expect(names).toContain("ToolSearch");
    expect(names).toContain("AskUser");
    expect(names).toContain("Brief");
    expect(names).toContain("TaskCreate");
    expect(names).toContain("TaskGet");
    expect(names).toContain("TaskList");
    expect(names).toContain("TaskOutput");
    expect(names).toContain("TaskStop");
    expect(names).toContain("TaskUpdate");
    expect(names).toContain("EnterPlanMode");
    expect(names).toContain("ExitPlanMode");
    expect(names).toContain("EnterWorktree");
    expect(names).toContain("ExitWorktree");
    expect(names).toContain("NotebookEdit");
    expect(names).toContain("Agent");
    expect(names).toContain("SendMessage");
    expect(names).toContain("TeamCreate");
    expect(names).toContain("TeamDelete");
    expect(names).toContain("CronCreate");
    expect(names).toContain("CronDelete");
    expect(names).toContain("CronList");
    expect(names).toContain("CronToggle");
    expect(names).toContain("McpToolCall");
    expect(names).toContain("ListMcpResources");
    expect(names).toContain("ReadMcpResource");
    expect(names).toContain("McpAuth");
    expect(names).toContain("RemoteTrigger");
    expect(names).toContain("Lsp");
    expect(tools).toHaveLength(40);
  });

  it("each tool has required fields", () => {
    const registry = createDefaultToolRegistry();
    for (const tool of registry.getAll()) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("can retrieve individual tools", () => {
    const registry = createDefaultToolRegistry();
    expect(registry.get("Bash")).toBeDefined();
    expect(registry.get("Read")).toBeDefined();
    expect(registry.get("Write")).toBeDefined();
    expect(registry.get("Edit")).toBeDefined();
    expect(registry.get("Glob")).toBeDefined();
    expect(registry.get("Grep")).toBeDefined();
    expect(registry.get("WebFetch")).toBeDefined();
    expect(registry.get("WebSearch")).toBeDefined();
    expect(registry.get("NonExistent")).toBeUndefined();
  });

  it("has() works for registered tools", () => {
    const registry = createDefaultToolRegistry();
    expect(registry.has("Bash")).toBe(true);
    expect(registry.has("nope")).toBe(false);
  });
});
