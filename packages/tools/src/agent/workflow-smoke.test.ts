import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseWorkflowNotification } from "@openharness/coordinator";
import { getTaskManager, resetTaskManager } from "@openharness/services";
import type { SpawnResult, TeammateSpawnConfig } from "@openharness/swarm";
import { createAgentWorkflowRunner } from "./workflow-runner";
import { createWorkflowTool } from "./workflow";

const NODE = process.execPath;

let tempDir: string | undefined;
let savedConfigDir: string | undefined;

beforeEach(() => {
  savedConfigDir = process.env.OPENHARNESS_CONFIG_DIR;
  tempDir = mkdtempSync(join(tmpdir(), "oh-workflow-smoke-"));
  process.env.OPENHARNESS_CONFIG_DIR = join(tempDir, "config");
  resetTaskManager();
});

afterEach(() => {
  resetTaskManager();
  if (savedConfigDir === undefined) delete process.env.OPENHARNESS_CONFIG_DIR;
  else process.env.OPENHARNESS_CONFIG_DIR = savedConfigDir;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("Workflow tool smoke", () => {
  it("runs through Workflow -> scheduler -> agent runner -> TaskManager", async () => {
    const spawned: TeammateSpawnConfig[] = [];
    const tool = createWorkflowTool({
      createRunner: (options) =>
        createAgentWorkflowRunner({
          ...options,
          spawnWorker: async (config) => spawnNodeWorker(config, spawned),
          getAgentDefinition: () => undefined,
        }),
    });

    const result = await tool.execute(
      {
        mode: "pipeline",
        timeoutSeconds: 5,
        tasks: [
          { id: "research", prompt: "find relevant files" },
          { id: "verify", prompt: "verify using prior output" },
        ],
      },
      { cwd: process.cwd() },
    );

    const text = textOf(result);
    const notification = parseWorkflowNotification(text);
    expect(result.isError).toBeUndefined();
    expect(notification).toMatchObject({
      status: "completed",
      summary: "2/2 tasks completed",
      mode: "pipeline",
      totalTasks: 2,
      completedTasks: 2,
      failedTasks: 0,
    });
    expect(notification?.tasks.map((task) => task.taskId)).toEqual(["research", "verify"]);
    expect(notification?.tasks[0]?.result).toContain("worker:research");
    expect(notification?.tasks[1]?.result).toContain("worker:verify");
    expect(spawned).toHaveLength(2);
    expect(spawned[1]!.prompt).toContain("Pipeline input:");
    expect(spawned[1]!.prompt).toContain("worker:research");
  });
});

async function spawnNodeWorker(
  config: TeammateSpawnConfig,
  spawned: TeammateSpawnConfig[],
): Promise<SpawnResult> {
  spawned.push(config);
  const task = await getTaskManager().createShellTask({
    argv: [
      NODE,
      "-e",
      "const id=process.env.WORKFLOW_TASK_ID; const prompt=process.env.WORKFLOW_PROMPT ?? ''; process.stdout.write(`worker:${id}\\nprompt:${prompt.slice(0,120)}`);",
    ],
    description: `workflow smoke ${config.name}`,
    cwd: config.cwd,
    type: "agent",
    env: {
      WORKFLOW_TASK_ID: config.sessionId?.split("-")[1] ?? config.name,
      WORKFLOW_PROMPT: config.prompt,
    },
  });
  return {
    success: true,
    agentId: `${config.name}@${config.team}`,
    taskId: task.id,
    backendType: "smoke",
  };
}

function textOf(result: Awaited<ReturnType<ReturnType<typeof createWorkflowTool>["execute"]>>): string {
  const block = result.content[0];
  return block && "text" in block ? String(block.text) : "";
}
