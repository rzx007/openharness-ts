import { describe, it, expect } from "vitest";
import { VimModeHandler } from "../src/index.js";

describe("VimModeHandler", () => {
  it("starts in normal mode", () => {
    const handler = new VimModeHandler();
    expect(handler.getMode()).toBe("normal");
  });

  it("transitions normal -> insert on 'i'", () => {
    const handler = new VimModeHandler();
    const t = handler.handleKey("i");
    expect(t).toEqual({ from: "normal", to: "insert", key: "i" });
    expect(handler.getMode()).toBe("insert");
  });

  it("transitions normal -> insert on 'a'", () => {
    const handler = new VimModeHandler();
    handler.handleKey("a");
    expect(handler.getMode()).toBe("insert");
  });

  it("transitions normal -> insert on 'o'", () => {
    const handler = new VimModeHandler();
    handler.handleKey("o");
    expect(handler.getMode()).toBe("insert");
  });

  it("transitions normal -> visual on 'v'", () => {
    const handler = new VimModeHandler();
    handler.handleKey("v");
    expect(handler.getMode()).toBe("visual");
  });

  it("transitions normal -> command on ':'", () => {
    const handler = new VimModeHandler();
    handler.handleKey(":");
    expect(handler.getMode()).toBe("command");
  });

  it("transitions insert -> normal on Escape", () => {
    const handler = new VimModeHandler();
    handler.handleKey("i");
    handler.handleKey("Escape");
    expect(handler.getMode()).toBe("normal");
  });

  it("transitions visual -> normal on Escape", () => {
    const handler = new VimModeHandler();
    handler.handleKey("v");
    handler.handleKey("Escape");
    expect(handler.getMode()).toBe("normal");
  });

  it("transitions command -> normal on Escape", () => {
    const handler = new VimModeHandler();
    handler.handleKey(":");
    handler.handleKey("Escape");
    expect(handler.getMode()).toBe("normal");
  });

  it("transitions command -> normal on Enter", () => {
    const handler = new VimModeHandler();
    handler.handleKey(":");
    handler.handleKey("Enter");
    expect(handler.getMode()).toBe("normal");
  });

  it("stays in insert on regular keys", () => {
    const handler = new VimModeHandler();
    handler.handleKey("i");
    handler.handleKey("x");
    handler.handleKey("y");
    expect(handler.getMode()).toBe("insert");
  });

  it("stays in visual on regular keys", () => {
    const handler = new VimModeHandler();
    handler.handleKey("v");
    handler.handleKey("j");
    expect(handler.getMode()).toBe("visual");
  });

  it("reset goes back to normal", () => {
    const handler = new VimModeHandler();
    handler.handleKey("i");
    handler.reset();
    expect(handler.getMode()).toBe("normal");
  });

  it("returns transition info from handleKey", () => {
    const handler = new VimModeHandler();
    const t = handler.handleKey("v");
    expect(t.from).toBe("normal");
    expect(t.to).toBe("visual");
    expect(t.key).toBe("v");
  });
});
