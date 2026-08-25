import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentChildController,
  AgentExecutionContext,
  Settings,
} from "@openharness/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOpenHarnessRuntime } from "./default-runtime.js";
import { configureDiscoveredExtensions, discoverOpenHarnessExtensions } from "./extensions.js";
import { getNativeToolRuntimeSnapshot } from "./native-tools/status.js";

const BASE_SETTINGS: Settings = {
  model: "host-model",
  apiFormat: "anthropic",
  maxTurns: 8,
  permission: { mode: "default" },
};

let tempRoot: string;
let previousConfigDir: string | undefined;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "ohs-runtime-extensions-"));
  previousConfigDir = process.env.OPENHARNESS_CONFIG_DIR;
  process.env.OPENHARNESS_CONFIG_DIR = join(tempRoot, "config");
});

afterEach(() => {
  if (previousConfigDir === undefined) {
    delete process.env.OPENHARNESS_CONFIG_DIR;
  } else {
    process.env.OPENHARNESS_CONFIG_DIR = previousConfigDir;
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

function writeProjectAgentPlugin(cwd: string, suffix: string, model: string): void {
  const pluginDir = join(tempRoot, "cache", suffix);
  const agentsDir = join(pluginDir, "agents");
  mkdirSync(join(pluginDir, ".openharness-plugin"), { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(pluginDir, ".openharness-plugin", "plugin.json"),
    JSON.stringify({ schemaVersion: 1, id: `dev.openharness.${suffix}`, name: suffix, version: "1.0.0", components: { agents: ["./agents"] } }),
  );
  writeFileSync(
    join(agentsDir, "reviewer.md"),
    `---\nmodel: ${model}\n---\nReview only this workspace.\n`,
  );
  const storePath = join(tempRoot, "config", "plugins", "installed.json");
  mkdirSync(join(storePath, ".."), { recursive: true });
  let store: { schemaVersion: 1; revision: number; plugins: Record<string, unknown> } = { schemaVersion: 1, revision: 0, plugins: {} };
  try { store = JSON.parse(readFileSync(storePath, "utf8")); } catch {}
  store.plugins[`project:${cwd}:dev.openharness.${suffix}`] = {
    id: `dev.openharness.${suffix}`, scope: "project", projectDir: cwd, enabled: true,
    currentVersion: "1.0.0", cachePath: pluginDir, origin: "native", requestedPermissions: [],
    approvedPermissions: [], installedAt: "now", updatedAt: "now",
  };
  writeFileSync(storePath, JSON.stringify(store));
}

function writeProjectToolPlugin(cwd: string): void {
  const pluginDir = join(tempRoot, "cache", "runtime-tool");
  mkdirSync(join(pluginDir, ".openharness-plugin"), { recursive: true });
  mkdirSync(join(pluginDir, "tools"), { recursive: true });
  writeFileSync(join(pluginDir, ".openharness-plugin", "plugin.json"), JSON.stringify({
    schemaVersion: 1,
    id: "dev.openharness.runtime-tool",
    name: "runtime-tool",
    version: "1.0.0",
    components: { tools: ["./tools/index.mjs"] },
  }));
  writeFileSync(join(pluginDir, "tools", "index.mjs"), `
    export async function registerTools() {
      return [{
        name: "InstalledPluginEcho", description: "installed plugin echo", inputSchema: {},
        async invoke(input) { return { content: [{ type: "text", text: String(input.value) }] }; }
      }];
    }
  `);
  const storePath = join(tempRoot, "config", "plugins", "installed.json");
  mkdirSync(join(storePath, ".."), { recursive: true });
  writeFileSync(storePath, JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    plugins: {
      [`project:${cwd}:dev.openharness.runtime-tool`]: {
        id: "dev.openharness.runtime-tool",
        scope: "project",
        projectDir: cwd,
        enabled: true,
        currentVersion: "1.0.0",
        cachePath: pluginDir,
        origin: "native",
        requestedPermissions: [],
        approvedPermissions: [],
        installedAt: "now",
        updatedAt: "now",
      },
    },
  }));
}

function createExecutionContext(
  cwd: string,
  calls: Parameters<AgentChildController["spawnChildAgent"]>[0][],
): AgentExecutionContext {
  const children: AgentChildController = {
    hasChildAgent: vi.fn(() => false),
    spawnChildAgent: vi.fn(async (input) => {
      calls.push(input);
      return {
        id: `child-${calls.length}`,
        sessionId: `child-session-${calls.length}`,
        result: Promise.resolve({
          status: "completed" as const,
          output: "done",
        }),
      };
    }),
    sendChildInput: vi.fn(async () => {}),
    interruptChildAgent: vi.fn(async () => {}),
    awaitChildAgent: vi.fn(async () => ({
      status: "completed" as const,
      output: "done",
    })),
  };
  return {
    scope: {
      agentId: "leader",
      sessionId: "leader-session",
      inputId: "input-1",
      runId: "run-1",
      traceId: "trace-1",
      cwd,
      signal: new AbortController().signal,
    },
    effects: {
      requestPermission: vi.fn(async () => ({ status: "approved" as const })),
    },
    children,
    emit: vi.fn(async () => {}),
    takeSteeredInputs: vi.fn(async () => []),
    closeSteering: vi.fn(),
  };
}

async function spawnReviewer(
  runtime: Awaited<ReturnType<typeof createOpenHarnessRuntime>>,
  cwd: string,
) {
  const calls: Parameters<AgentChildController["spawnChildAgent"]>[0][] = [];
  const tool = runtime.toolRegistry.get("Agent");
  expect(tool).toBeDefined();

  await tool!.execute(
    {
      description: "review",
      prompt: "review this workspace",
      subagentType: cwd.endsWith("workspace-a")
        ? "dev.openharness.plugin-a:reviewer"
        : "dev.openharness.plugin-b:reviewer",
    },
    { cwd, agent: createExecutionContext(cwd, calls) },
  );

  return calls[0];
}

describe("extension agent definition scoping", () => {
  it("keeps two live runtimes bound to the plugin agents discovered for their own cwd", async () => {
    const cwdA = join(tempRoot, "workspace-a");
    const cwdB = join(tempRoot, "workspace-b");
    writeProjectAgentPlugin(cwdA, "plugin-a", "model-a");
    writeProjectAgentPlugin(cwdB, "plugin-b", "model-b");

    const discoveryA = await discoverOpenHarnessExtensions(cwdA, BASE_SETTINGS);
    const runtimeA = await createOpenHarnessRuntime({
      settings: BASE_SETTINGS,
      cwd: cwdA,
      configuration: {
        client: {
          async *streamMessage() {
            yield {
              type: "complete" as const,
              stopReason: "end_turn" as const,
            };
          },
        },
      },
      agentDefinitions: discoveryA.agentDefinitions,
    });

    const discoveryB = await discoverOpenHarnessExtensions(cwdB, BASE_SETTINGS);
    const runtimeB = await createOpenHarnessRuntime({
      settings: BASE_SETTINGS,
      cwd: cwdB,
      configuration: {
        client: {
          async *streamMessage() {
            yield {
              type: "complete" as const,
              stopReason: "end_turn" as const,
            };
          },
        },
      },
      agentDefinitions: discoveryB.agentDefinitions,
    });

    try {
      const [spawnedByA, spawnedByB] = await Promise.all([
        spawnReviewer(runtimeA, cwdA),
        spawnReviewer(runtimeB, cwdB),
      ]);
      expect(spawnedByA?.model).toBe("model-a");
      expect(spawnedByB?.model).toBe("model-b");
    } finally {
      await Promise.all([runtimeA.close(), runtimeB.close()]);
    }
  });
});

describe("installed Native Tool activation", () => {
  it("discovers, invokes, and removes a Tool with its owning runtime", async () => {
    const cwd = join(tempRoot, "tool-workspace");
    writeProjectToolPlugin(cwd);
    const discovery = await discoverOpenHarnessExtensions(cwd, BASE_SETTINGS);
    const runtime = await createOpenHarnessRuntime({
      settings: BASE_SETTINGS,
      cwd,
      configuration: {
        client: {
          async *streamMessage() {
            yield { type: "complete" as const, stopReason: "end_turn" as const };
          },
        },
      },
    });
    const activations = await configureDiscoveredExtensions(discovery, {
      cwd,
      toolRegistry: runtime.toolRegistry,
      hookExecutor: runtime.hookExecutor,
      addCleanup: (cleanup, cleanupSync) => runtime.addCleanup(cleanup, cleanupSync),
    });
    expect(activations[0]).toMatchObject({ state: "active", toolNames: ["InstalledPluginEcho"] });
    expect(getNativeToolRuntimeSnapshot(discovery.plugins[0]!.root)).toMatchObject({
      state: "active",
      hostCount: 1,
      registeredToolCount: 1,
      toolNames: ["InstalledPluginEcho"],
    });
    await expect(runtime.toolRegistry.get("InstalledPluginEcho")!.execute({ value: "hello" }, { cwd })).resolves.toEqual({
      content: [{ type: "text", text: "hello" }],
    });
    await runtime.close();
    expect(runtime.toolRegistry.has("InstalledPluginEcho")).toBe(false);
    expect(getNativeToolRuntimeSnapshot(discovery.plugins[0]!.root)).toMatchObject({ state: "inactive", hostCount: 0 });
  });
});
