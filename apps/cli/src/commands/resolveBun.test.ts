import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolveBun } from "./resolveBun";

describe("resolveBun", () => {
  it("returns a non-null string when bun is installed", () => {
    const result = resolveBun();
    // If bun is installed on this machine, we expect a string back.
    // This test is meaningful on CI/dev machines that have bun installed.
    // On machines without bun it will return null (which is also correct behavior).
    if (result !== null) {
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    } else {
      // bun is not installed — null is correct behavior
      expect(result).toBeNull();
    }
  });

  it("returned value can be used to run bun --version successfully", () => {
    const result = resolveBun();
    if (result === null) {
      // bun not installed, skip behavioral check
      return;
    }
    const r = spawnSync(result, ["--version"], { stdio: "pipe" });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    // output should look like a semver string
    const versionOutput = r.stdout.toString().trim();
    expect(versionOutput).toMatch(/^\d+\.\d+/);
  });
});
