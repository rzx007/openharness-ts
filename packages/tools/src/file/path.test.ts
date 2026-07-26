import { describe, expect, it } from "vitest";
import { normalizeToolPath } from "./path.js";

describe("normalizeToolPath", () => {
  it("converts WSL drive paths on Windows", () => {
    expect(normalizeToolPath("/mnt/d/code/project", "win32")).toBe("D:\\code\\project");
    expect(normalizeToolPath("/mnt/c", "win32")).toBe("C:\\");
  });

  it("leaves WSL-looking paths unchanged on non-Windows platforms", () => {
    expect(normalizeToolPath("/mnt/d/code/project", "linux")).toBe("/mnt/d/code/project");
    expect(normalizeToolPath("/mnt/d/code/project", "darwin")).toBe("/mnt/d/code/project");
  });
});
