import { describe, it, expect } from "vitest";
import { KeyBindingManager } from "../src/index.js";
import type { KeyBinding } from "../src/index.js";

describe("KeyBindingManager", () => {
  it("registers and resolves a binding", () => {
    const mgr = new KeyBindingManager();
    mgr.register({ key: "s", ctrl: true, command: "save" });
    const result = mgr.resolve({ key: "s", ctrl: true });
    expect(result).toBeDefined();
    expect(result!.command).toBe("save");
  });

  it("returns undefined for unbound key", () => {
    const mgr = new KeyBindingManager();
    expect(mgr.resolve({ key: "x" })).toBeUndefined();
  });

  it("distinguishes modifiers", () => {
    const mgr = new KeyBindingManager();
    mgr.register({ key: "s", ctrl: true, command: "save" });
    const result = mgr.resolve({ key: "s", ctrl: false });
    expect(result).toBeUndefined();
  });

  it("resolves mode-specific bindings", () => {
    const mgr = new KeyBindingManager();
    mgr.registerMode("insert", [{ key: "Escape", command: "exitInsert" }]);
    const result = mgr.resolve(
      { key: "Escape" },
      { activeMode: "insert" }
    );
    expect(result).toBeDefined();
    expect(result!.command).toBe("exitInsert");
  });

  it("falls back to global when mode has no match", () => {
    const mgr = new KeyBindingManager();
    mgr.register({ key: "q", command: "quit" });
    mgr.registerMode("insert", [{ key: "Escape", command: "exitInsert" }]);
    const result = mgr.resolve(
      { key: "q" },
      { activeMode: "insert" }
    );
    expect(result).toBeDefined();
    expect(result!.command).toBe("quit");
  });

  it("lists all bindings", () => {
    const mgr = new KeyBindingManager();
    mgr.register({ key: "a", command: "cmdA" });
    mgr.register({ key: "b", command: "cmdB" });
    expect(mgr.list()).toHaveLength(2);
  });

  it("listModes returns registered modes", () => {
    const mgr = new KeyBindingManager();
    mgr.registerMode("insert", []);
    mgr.registerMode("visual", []);
    expect(mgr.listModes()).toEqual(["insert", "visual"]);
  });

  it("unregister removes a binding", () => {
    const mgr = new KeyBindingManager();
    mgr.register({ key: "x", command: "delete" });
    expect(mgr.unregister("x")).toBe(true);
    expect(mgr.resolve({ key: "x" })).toBeUndefined();
  });
});
