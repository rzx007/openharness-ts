import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IToolRegistry, ToolDefinition } from "@openharness/core";
import { loadNativePlugin, validateNativePlugin } from "@openharness/plugins";
import { afterEach, describe, expect, it } from "vitest";
import { activateNativePluginTools } from "./activate.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class TestRegistry implements IToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  register(tool: ToolDefinition): void { this.tools.set(tool.name, tool); }
  unregister(name: string): boolean { return this.tools.delete(name); }
  get(name: string): ToolDefinition | undefined { return this.tools.get(name); }
  getAll(): ToolDefinition[] { return [...this.tools.values()]; }
  has(name: string): boolean { return this.tools.has(name); }
}

function writePlugin(moduleSource: string, id = "dev.openharness.runtime-tool") {
  const root = mkdtempSync(join(tmpdir(), "openharness-native-tool-"));
  roots.push(root);
  mkdirSync(join(root, ".openharness-plugin"), { recursive: true });
  mkdirSync(join(root, "tools"), { recursive: true });
  writeFileSync(join(root, ".openharness-plugin", "plugin.json"), JSON.stringify({
    schemaVersion: 1,
    id,
    name: id.split(".").at(-1),
    version: "1.0.0",
    components: { tools: ["./tools/index.mjs"] },
  }));
  writeFileSync(join(root, "tools", "index.mjs"), moduleSource);
  return root;
}

async function loadPlugin(root: string) {
  const validation = await validateNativePlugin(root);
  expect(validation.status).toBe("valid");
  return await loadNativePlugin(validation.plugin!);
}

describe("NativeToolHost", () => {
  it("registers and invokes multiple tools in a child process, then cleans them up", async () => {
    const plugin = await loadPlugin(writePlugin(`
      export async function registerTools(ctx) {
        return [
          {
            name: "PluginEcho",
            description: "echo input",
            inputSchema: { type: "object" },
            async invoke(input) { return { content: [{ type: "text", text: ctx.plugin.id + ":" + input.value }] }; }
          },
          {
            name: "PluginFailure",
            description: "fail without crashing host",
            inputSchema: { type: "object" },
            async invoke() { throw new Error("expected tool failure"); }
          }
        ];
      }
    `));
    const registry = new TestRegistry();
    const cleanups: Array<() => Promise<void> | void> = [];
    const activation = await activateNativePluginTools(plugin, {
      cwd: plugin.root,
      toolRegistry: registry,
      addCleanup: (cleanup) => cleanups.push(cleanup),
    });

    expect(activation.state).toBe("active");
    expect(activation.toolNames).toEqual(["PluginEcho", "PluginFailure"]);
    await expect(registry.get("PluginFailure")!.execute({}, { cwd: plugin.root })).rejects.toMatchObject({ code: "tool_call_failed" });
    await expect(registry.get("PluginEcho")!.execute({ value: "ok" }, { cwd: plugin.root })).resolves.toEqual({
      content: [{ type: "text", text: "dev.openharness.runtime-tool:ok" }],
    });

    await cleanups[0]!();
    expect(registry.getAll()).toEqual([]);
    expect(activation.host?.state).toBe("inactive");
  });

  it("returns a structured registration error when registerTools is missing", async () => {
    const plugin = await loadPlugin(writePlugin(`export const value = 1;`, "dev.openharness.missing-register"));
    const activation = await activateNativePluginTools(plugin, {
      cwd: plugin.root,
      toolRegistry: new TestRegistry(),
      addCleanup: () => undefined,
    });
    expect(activation.state).toBe("error");
    expect(activation.diagnostics[0]).toMatchObject({ code: "tool_register_failed", component: "tools" });
  });

  it("times out a call without taking down the host", async () => {
    const plugin = await loadPlugin(writePlugin(`
      export async function registerTools() {
        return [{
          name: "PluginSlow", description: "slow", inputSchema: {},
          async invoke(_input, context) {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, 10000);
              context.signal.addEventListener("abort", () => { clearTimeout(timer); reject(context.signal.reason); }, { once: true });
            });
            return { content: [] };
          }
        }];
      }
    `, "dev.openharness.slow-tool"));
    const registry = new TestRegistry();
    const cleanups: Array<() => Promise<void> | void> = [];
    const activation = await activateNativePluginTools(plugin, {
      cwd: plugin.root,
      toolRegistry: registry,
      callTimeoutMs: 50,
      addCleanup: (cleanup) => cleanups.push(cleanup),
    });
    await expect(registry.get("PluginSlow")!.execute({}, { cwd: plugin.root })).rejects.toMatchObject({ code: "tool_call_timeout" });
    expect(activation.host?.state).toBe("active");
    await cleanups[0]!();
  });

  it("kills an unresponsive host and unregisters its tools after the cancellation grace period", async () => {
    const plugin = await loadPlugin(writePlugin(`
      export async function registerTools() {
        return [{
          name: "PluginBlocked", description: "blocks synchronously", inputSchema: {},
          invoke() {
            const until = Date.now() + 5000;
            while (Date.now() < until) {}
            return { content: [] };
          }
        }];
      }
    `, "dev.openharness.blocked-tool"));
    const registry = new TestRegistry();
    const activation = await activateNativePluginTools(plugin, {
      cwd: plugin.root,
      toolRegistry: registry,
      callTimeoutMs: 25,
      cancellationGraceMs: 25,
      addCleanup: () => undefined,
    });

    await expect(registry.get("PluginBlocked")!.execute({}, { cwd: plugin.root }))
      .rejects.toMatchObject({ code: "tool_call_timeout" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(activation.host?.state).toBe("error");
    expect(registry.getAll()).toEqual([]);
  });

  it("removes every registered tool when its host process crashes", async () => {
    const plugin = await loadPlugin(writePlugin(`
      export async function registerTools() {
        return [{
          name: "PluginCrash", description: "crash host", inputSchema: {},
          async invoke() { process.exit(17); }
        }];
      }
    `, "dev.openharness.crash-tool"));
    const registry = new TestRegistry();
    const activation = await activateNativePluginTools(plugin, {
      cwd: plugin.root,
      toolRegistry: registry,
      addCleanup: () => undefined,
    });
    await expect(registry.get("PluginCrash")!.execute({}, { cwd: plugin.root })).rejects.toMatchObject({ code: "tool_host_crashed" });
    expect(registry.getAll()).toEqual([]);
    expect(activation.host?.state).toBe("error");
  });
});
