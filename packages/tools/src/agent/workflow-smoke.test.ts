import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseWorkflowNotification, WorkflowRunStore } from "@openharness/coordinator";
import type { AgentChildAgentHost, ToolRuntimeHost } from "@openharness/core";
import { createAgentWorkflowRunner } from "./workflow-runner";
import { createWorkflowTool } from "./workflow";

let tempDir: string | undefined;
let savedConfigDir: string | undefined;

beforeEach(() => {
  savedConfigDir = process.env.OPENHARNESS_CONFIG_DIR;
  tempDir = mkdtempSync(join(tmpdir(), "oh-workflow-smoke-"));
  process.env.OPENHARNESS_CONFIG_DIR = join(tempDir, "config");
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.OPENHARNESS_CONFIG_DIR;
  else process.env.OPENHARNESS_CONFIG_DIR = savedConfigDir;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  tempDir = undefined;
});

describe("Workflow tool smoke", () => {
  it("runs through Workflow -> runtime host child-agent port -> task wait adapter", async () => {
    const spawned: Array<Parameters<AgentChildAgentHost["spawnChildAgent"]>[0]> = [];
    const outputs = new Map<string, string>();
    const runtimeHost: ToolRuntimeHost = {
      emitEvent: () => {},
      requestPermission: async () => ({ status: "approved" }),
      childAgentHost: {
        spawnChildAgent: async (input) => {
          spawned.push(input);
          const taskName = input.sessionId?.match(/^wf-(.+)-\d+-/)?.[1] ?? input.agent;
          const taskId = `task_${taskName}`;
          outputs.set(taskId, `worker:${taskName}`);
          return {
            id: `invocation_${taskName}`,
            taskId,
            sessionId: input.sessionId,
            result: Promise.resolve({ status: "completed", output: outputs.get(taskId) ?? "" }),
          };
        },
        sendChildInput: async () => {},
        interruptChildAgent: async () => {},
        awaitChildAgent: async (id) => ({ status: "completed", output: `worker:${id}` }),
      },
    };
    const tool = createWorkflowTool({
      createRunner: (options) =>
        createAgentWorkflowRunner({
          ...options,
          awaitTask: async (taskId) => ({
            status: "completed",
            output: outputs.get(taskId) ?? "",
            exitCode: 0,
          }),
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
      { cwd: tempDir!, runtimeHost },
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
