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

  it("JSON object without text yields empty (structured non-prompt message)", () => {
    expect(decodeTaskWorkerLine('{"type":"shutdown"}')).toBe("");
  });
});
