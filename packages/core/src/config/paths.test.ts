import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { getProjectMemoryDir } from "./paths";

describe("getProjectMemoryDir", () => {
  it("stores project memory under data/memory with a project hash", () => {
    const a = getProjectMemoryDir(join("C:", "work", "alpha"));
    const b = getProjectMemoryDir(join("C:", "work", "beta"));

    expect(a).toContain(join("data", "memory", "alpha-"));
    expect(b).toContain(join("data", "memory", "beta-"));
    expect(a).not.toBe(b);
  });
});
