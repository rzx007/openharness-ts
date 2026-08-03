import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseWorkflowNotification, WorkflowRunStore } from "@openharness/coordinator";
import { getTaskManager, resetTaskManager } from "@openharness/services";
import { ChildSessionBackend, type TeammateSpawnConfig } from "@openharness/swarm";
import { createAgentWorkflowRunner } from "./workflow-runner";
import { createWorkflowTool } from "./workflow";

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
  if (tempDir) rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  tempDir = undefined;
});

describe("Workflow tool smoke", () => {
  it("runs through Workflow -> child session backend -> TaskManager bridge", async () => {
    const spawned: TeammateSpawnConfig[] = [];
    const manager = getTaskManager(tempDir!);
    const backend = new ChildSessionBackend({
      host: {
        createChildSession: async (input) => ({ id: input.id ?? `child-${spawned.length}` }),
        admitPrompt: async (sessionId) => ({ runId: `run-${sessionId}` }),
        awaitRun: async (sessionId) => ({
          status: "completed",
          output: `worker:${sessionId.split("-")[1] ?? sessionId}`,
        }),
        interrupt: async () => {},
        archive: async () => {},
      },
      taskBridge: {
        registerSessionTask: (input) => manager.registerSessionTask(input),
        completeSessionTask: (id, input) => manager.completeSessionTask(id, input),
        writeToSessionTask: (id, data) => manager.writeToTask(id, data),
      },
    });
    const tool = createWorkflowTool({
      createRunner: (options) =>
        createAgentWorkflowRunner({
          ...options,
          spawnWorker: async (config) => {
            spawned.push(config);
            return await backend.spawn(config);
          },
          awaitTask: (taskId, waitOptions) => manager.awaitTask(taskId, waitOptions),
          getDiffSummary: async () => ({ changedFiles: [], insertions: 0, deletions: 0 }),
          getAgentDefinition: () => undefined,
        }),
    });

    const result = await tool.execute(
      {
        mode: "pipeline",
        waitForCompletion: true,
        timeoutSeconds: 5,
        tasks: [
          { id: "research", prompt: "find relevant files" },
          { id: "verify", prompt: "verify using prior output" },
        ],
      },
      { cwd: tempDir! },
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

    const stored = new WorkflowRunStore({ cwd: tempDir! }).list();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe("completed");
    expect(stored[0]?.orderedResults.map((task) => task.taskId)).toEqual(["research", "verify"]);
  });
});

function textOf(result: Awaited<ReturnType<ReturnType<typeof createWorkflowTool>["execute"]>>): string {
  const block = result.content[0];
  return block && "text" in block ? String(block.text) : "";
}
