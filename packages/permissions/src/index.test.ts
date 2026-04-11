import { describe, it, expect } from "vitest";
import { PermissionChecker } from "../src/index.js";
import type { PermissionCheckOptions } from "../src/index.js";

describe("PermissionChecker", () => {
  it("allows all tools in full_auto mode", async () => {
    const checker = new PermissionChecker({
      mode: "full_auto",
      rules: [],
    });
    const result = await checker.checkTool("bash", { command: "rm -rf /" });
    expect(result.action).toBe("allow");
  });

  it("asks in default mode with no rules", async () => {
    const checker = new PermissionChecker({
      mode: "default",
      rules: [],
    });
    const result = await checker.checkTool("bash", {});
    expect(result.action).toBe("ask");
  });

  it("asks in plan mode", async () => {
    const checker = new PermissionChecker({
      mode: "plan",
      rules: [],
    });
    const result = await checker.checkTool("read_file", {});
    expect(result.action).toBe("ask");
  });

  it("allows tool matching an allow rule", async () => {
    const checker = new PermissionChecker({
      mode: "default",
      rules: [{ tool: "read_file", action: "allow" }],
    });
    const result = await checker.checkTool("read_file", {});
    expect(result.action).toBe("allow");
  });

  it("denies tool matching a deny rule", async () => {
    const checker = new PermissionChecker({
      mode: "default",
      rules: [{ tool: "bash", action: "deny" }],
    });
    const result = await checker.checkTool("bash", {});
    expect(result.action).toBe("deny");
  });

  it("skips rule when tool name does not match", async () => {
    const checker = new PermissionChecker({
      mode: "default",
      rules: [{ tool: "bash", action: "deny" }],
    });
    const result = await checker.checkTool("read_file", {});
    expect(result.action).toBe("ask");
  });

  it("matches pathPattern with glob", async () => {
    const checker = new PermissionChecker({
      mode: "default",
      rules: [
        { pathPattern: "/safe/*", action: "allow" },
      ],
    });
    const allow = await checker.checkTool("read_file", { path: "/safe/file.txt" });
    expect(allow.action).toBe("allow");
    const deny = await checker.checkTool("read_file", { path: "/etc/passwd" });
    expect(deny.action).toBe("ask");
  });

  it("matches commandPattern with glob", async () => {
    const checker = new PermissionChecker({
      mode: "default",
      rules: [
        { commandPattern: "git *", action: "allow" },
      ],
    });
    const allow = await checker.checkTool("bash", { command: "git status" });
    expect(allow.action).toBe("allow");
    const deny = await checker.checkTool("bash", { command: "rm -rf /" });
    expect(deny.action).toBe("ask");
  });

  it("addRule adds new rule", async () => {
    const checker = new PermissionChecker({ mode: "default", rules: [] });
    checker.addRule({ tool: "bash", action: "deny" });
    const result = await checker.checkTool("bash", {});
    expect(result.action).toBe("deny");
  });

  it("removeRule removes rule by index", async () => {
    const checker = new PermissionChecker({
      mode: "default",
      rules: [{ tool: "bash", action: "deny" }],
    });
    checker.removeRule(0);
    const result = await checker.checkTool("bash", {});
    expect(result.action).toBe("ask");
  });

  it("getRules returns current rules", () => {
    const rules = [{ tool: "bash", action: "deny" as const }];
    const checker = new PermissionChecker({ mode: "default", rules });
    expect(checker.getRules()).toEqual(rules);
  });

  it("setMode changes mode", async () => {
    const checker = new PermissionChecker({ mode: "default", rules: [] });
    checker.setMode("full_auto");
    expect(checker.getMode()).toBe("full_auto");
    const result = await checker.checkTool("bash", {});
    expect(result.action).toBe("allow");
  });
});
