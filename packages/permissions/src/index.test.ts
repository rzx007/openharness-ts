import { describe, it, expect } from "vitest";
import { PermissionChecker, READ_ONLY_TOOLS } from "../src/index.js";
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

describe("autoApproveTools (swarm worker read-only auto-approval)", () => {
  it("allows an auto-approved tool in default mode", async () => {
    const checker = new PermissionChecker({
      mode: "default",
      autoApproveTools: ["Read", "Grep"],
    });
    const result = await checker.checkTool("Read", { path: "/foo" });
    expect(result.action).toBe("allow");
    expect(result.reason).toBe("Auto-approved read-only tool (swarm worker)");
  });

  it("still asks for non-auto-approved tools in default mode", async () => {
    const checker = new PermissionChecker({
      mode: "default",
      autoApproveTools: ["Read", "Grep"],
    });
    const result = await checker.checkTool("Write", { path: "/foo" });
    expect(result.action).toBe("ask");
  });

  it("deniedTools takes priority over autoApprove (deny wins)", async () => {
    const checker = new PermissionChecker({
      mode: "default",
      deniedTools: ["Read"],
      autoApproveTools: ["Read"],
    });
    const result = await checker.checkTool("Read", { path: "/foo" });
    expect(result.action).toBe("deny");
  });

  it("full_auto still short-circuits before autoApprove", async () => {
    const checker = new PermissionChecker({
      mode: "full_auto",
      deniedTools: ["Read"],
      autoApproveTools: ["Read"],
    });
    // full_auto is checked first, so even a denied+auto-approved tool allows.
    const result = await checker.checkTool("Read", { path: "/foo" });
    expect(result.action).toBe("allow");
    expect(result.reason).toBe("Full auto mode");
  });

  it("autoApprove放行 even when an allowedTools whitelist is set (order correct)", async () => {
    // allowedTools whitelist does NOT contain Read, but autoApprove is checked
    // first and放行 it.
    const checker = new PermissionChecker({
      mode: "default",
      allowedTools: ["SomeOtherTool"],
      autoApproveTools: ["Read"],
    });
    const result = await checker.checkTool("Read", { path: "/foo" });
    expect(result.action).toBe("allow");
    expect(result.reason).toBe("Auto-approved read-only tool (swarm worker)");
  });

  it("no autoApproveTools → behavior unchanged (default mode asks)", async () => {
    const checker = new PermissionChecker({ mode: "default", rules: [] });
    const result = await checker.checkTool("Read", { path: "/foo" });
    expect(result.action).toBe("ask");
  });
});

describe("READ_ONLY_TOOLS", () => {
  it("contains common read-only tools", () => {
    for (const tool of ["Read", "Grep", "Glob", "WebFetch", "WebSearch"]) {
      expect(READ_ONLY_TOOLS.has(tool)).toBe(true);
    }
  });

  it("does not contain write/execute tools", () => {
    for (const tool of ["Write", "Edit", "Bash"]) {
      expect(READ_ONLY_TOOLS.has(tool)).toBe(false);
    }
  });
});
