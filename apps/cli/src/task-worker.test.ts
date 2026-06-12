import { describe, it, expect } from "vitest";
import { decodeTaskWorkerLine } from "./commands/main.js";

describe("decodeTaskWorkerLine", () => {
  it("extracts text from a JSON envelope", () => {
    expect(decodeTaskWorkerLine('{"text":"do the task","from":"coordinator"}')).toBe("do the task");
  });

  it("treats non-JSON as a plain prompt and skips blanks", () => {
    expect(decodeTaskWorkerLine("just a prompt")).toBe("just a prompt");
    expect(decodeTaskWorkerLine("   ")).toBe("");
  });

  it("JSON object without text falls back to the raw line (Python parity)", () => {
    expect(decodeTaskWorkerLine('{"type":"shutdown"}')).toBe('{"type":"shutdown"}');
    expect(decodeTaskWorkerLine("[1,2]")).toBe("[1,2]");
  });
});
