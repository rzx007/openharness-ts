import { describe, it, expect, vi } from "vitest";
import { closeTaskWorkerInputForExit, decodeTaskWorkerLine } from "./commands/main.js";

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

describe("closeTaskWorkerInputForExit", () => {
  it("releases the one-shot worker stdin stream", () => {
    const input = {
      destroyed: false,
      pause: vi.fn(),
      removeAllListeners: vi.fn(),
      destroy: vi.fn(() => {
        input.destroyed = true;
        return input;
      }),
    };

    closeTaskWorkerInputForExit(input as unknown as NodeJS.ReadStream);

    expect(input.pause).toHaveBeenCalledOnce();
    expect(input.removeAllListeners).toHaveBeenCalledWith("data");
    expect(input.removeAllListeners).toHaveBeenCalledWith("readable");
    expect(input.removeAllListeners).toHaveBeenCalledWith("end");
    expect(input.destroy).toHaveBeenCalledOnce();
    expect(input.destroyed).toBe(true);
  });
});
