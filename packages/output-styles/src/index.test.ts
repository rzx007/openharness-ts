import { describe, it, expect } from "vitest";
import { OutputStyleLoader } from "../src/index.js";
import type { OutputStyleDefinition } from "../src/index.js";

describe("OutputStyleLoader", () => {
  it("has default style built-in", () => {
    const loader = new OutputStyleLoader();
    expect(loader.get("default")).toBeDefined();
    expect(loader.get("default")!.name).toBe("Default");
  });

  it("getAll includes default", () => {
    const loader = new OutputStyleLoader();
    expect(loader.getAll()).toHaveLength(1);
  });

  it("registers a custom style", () => {
    const loader = new OutputStyleLoader();
    const style: OutputStyleDefinition = {
      id: "markdown",
      name: "Markdown",
      description: "Formats as markdown",
      format: (c) => `> ${c}`,
    };
    loader.register(style);
    expect(loader.get("markdown")).toBe(style);
    expect(loader.getAll()).toHaveLength(2);
  });

  it("get returns undefined for unknown style", () => {
    const loader = new OutputStyleLoader();
    expect(loader.get("nope")).toBeUndefined();
  });

  it("default style formats content as-is", () => {
    const loader = new OutputStyleLoader();
    const style = loader.get("default")!;
    expect(style.format("hello")).toBe("hello");
  });

  it("overwrites existing style on re-register", () => {
    const loader = new OutputStyleLoader();
    const v1: OutputStyleDefinition = {
      id: "test",
      name: "V1",
      description: "first",
      format: (c) => c.toUpperCase(),
    };
    const v2: OutputStyleDefinition = {
      id: "test",
      name: "V2",
      description: "second",
      format: (c) => c.toLowerCase(),
    };
    loader.register(v1);
    loader.register(v2);
    expect(loader.get("test")!.name).toBe("V2");
  });
});
