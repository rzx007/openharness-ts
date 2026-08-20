import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentChildController,
  AgentExecutionContext,
  Settings,
} from "@openharness/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOpenHarnessRuntime } from "./default-runtime.js";
import { discoverOpenHarnessExtensions } from "./extensions.js";

const BASE_SETTINGS: Settings = {
  model: "host-model",
  apiFormat: "anthropic",
  maxTurns: 8,
  permission: { mode: "default" },
  allowProjectPlugins: true,
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

function writeProjectAgentPlugin(cwd: string, model: string): void {
  const pluginDir = join(cwd, ".openharness", "plugins", "scoped");
  const agentsDir = join(pluginDir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(pluginDir, "plugin.json"),
    JSON.stringify({ name: "scoped", version: "1.0.0" }),
  );
  writeFileSync(
    join(agentsDir, "reviewer.md"),
    `---\nmodel: ${model}\n---\nReview only this workspace.\n`,
  );
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
      subagentType: "scoped:reviewer",
    },
    { cwd, agent: createExecutionContext(cwd, calls) },
  );

  return calls[0];
}

describe("extension agent definition scoping", () => {
  it("keeps two live runtimes bound to the plugin agents discovered for their own cwd", async () => {
    const cwdA = join(tempRoot, "workspace-a");
    const cwdB = join(tempRoot, "workspace-b");
    writeProjectAgentPlugin(cwdA, "model-a");
    writeProjectAgentPlugin(cwdB, "model-b");

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
