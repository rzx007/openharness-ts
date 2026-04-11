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
    expect(tools).toHaveLength(15);
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
