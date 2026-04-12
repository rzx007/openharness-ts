import { describe, it, expect, vi } from "vitest";
import { HookExecutor } from "../src/index.js";
import type { HookDefinition } from "@openharness/core";

describe("HookExecutor", () => {
  it("registers and retrieves hooks", () => {
    const executor = new HookExecutor();
    const hook: HookDefinition = {
      id: "h1",
      event: "pre_tool_use",
      type: "command",
      command: "echo hello",
      enabled: true,
    };
    executor.register(hook);
    expect(executor.getHooksForEvent("pre_tool_use")).toHaveLength(1);
  });

  it("unregister removes hook", () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h1",
      event: "pre_tool_use",
      type: "command",
      command: "echo hello",
      enabled: true,
    });
    executor.unregister("h1");
    expect(executor.getHooksForEvent("pre_tool_use")).toHaveLength(0);
  });

  it("getHooksForEvent filters by event and enabled", () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h1",
      event: "pre_tool_use",
      type: "command",
      command: "echo a",
      enabled: true,
    });
    executor.register({
      id: "h2",
      event: "post_tool_use",
      type: "command",
      command: "echo b",
      enabled: true,
    });
    executor.register({
      id: "h3",
      event: "pre_tool_use",
      type: "command",
      command: "echo c",
      enabled: false,
    });
    expect(executor.getHooksForEvent("pre_tool_use")).toHaveLength(1);
    expect(executor.getHooksForEvent("post_tool_use")).toHaveLength(1);
  });

  it("execute runs command hooks", async () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h1",
      event: "session_start",
      type: "command",
      command: "echo test",
      enabled: true,
    });
    await executor.execute("session_start", {});
  });

  it("execute swallows errors", async () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h1",
      event: "session_start",
      type: "command",
      command: "exit 1",
      enabled: true,
    });
    await expect(executor.execute("session_start", {})).resolves.toEqual({ blocked: false });
  });

  it("executeWithResults returns results", async () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h1",
      event: "session_start",
      type: "command",
      command: "echo ok",
      enabled: true,
    });
    const results = await executor.executeWithResults("session_start", {});
    expect(results).toHaveLength(1);
    expect(results[0].hookId).toBe("h1");
    expect(results[0].success).toBe(true);
    expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("executeWithResults captures failures", async () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h1",
      event: "session_start",
      type: "command",
      command: "exit 2",
      enabled: true,
    });
    const results = await executor.executeWithResults("session_start", {});
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBeDefined();
  });

  it("getAll returns all hooks", () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h1",
      event: "pre_tool_use",
      type: "command",
      command: "echo a",
      enabled: true,
    });
    executor.register({
      id: "h2",
      event: "post_tool_use",
      type: "command",
      command: "echo b",
      enabled: true,
    });
    expect(executor.getAll()).toHaveLength(2);
  });

  it("executeCommand succeeds for valid command", async () => {
    const executor = new HookExecutor();
    const controller = new AbortController();
    await expect(
      executor.executeCommand("echo hello", controller.signal)
    ).resolves.toEqual({ blocked: false });
  });

  it("executeCommand returns blocked for exit code 2", async () => {
    const executor = new HookExecutor();
    const controller = new AbortController();
    const result = await executor.executeCommand("exit 2", controller.signal);
    expect(result.blocked).toBe(true);
  });

  it("executeCommand returns not blocked for non-zero exit", async () => {
    const executor = new HookExecutor();
    const controller = new AbortController();
    const result = await executor.executeCommand("exit 42", controller.signal);
    expect(result.blocked).toBe(false);
  });

  it("execute returns blocked when hook exits with code 2", async () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h1",
      event: "pre_tool_use",
      type: "command",
      command: "echo blocked && exit 2",
      enabled: true,
    });
    const result = await executor.execute("pre_tool_use", { tool: "bash" });
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("blocked");
  });

  it("execute returns blocked with reason from stdout", async () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h1",
      event: "pre_tool_use",
      type: "command",
      command: "echo 'dangerous operation detected' && exit 2",
      enabled: true,
    });
    const result = await executor.execute("pre_tool_use", { tool: "bash" });
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("dangerous");
  });
});
