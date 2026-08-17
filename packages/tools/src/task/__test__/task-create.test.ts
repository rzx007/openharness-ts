import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getTaskManager, resetTaskManager } from "@openharness/services";
import { afterEach, describe, expect, it } from "vitest";

import { taskCreateTool } from "../task-tools.js";

const createdDirectories: string[] = [];

afterEach(() => {
  for (const cwd of createdDirectories.splice(0)) {
    resetTaskManager({ cwd, sessionId: "session-1" });
    rmSync(cwd, { recursive: true, force: true });
  }
});

describe("TaskCreate", () => {
  it("exposes only the background shell producer inputs", () => {
    const schema = taskCreateTool.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };

    expect(Object.keys(schema.properties)).toEqual(["description", "command"]);
    expect(schema.required).toEqual(["description", "command"]);
  });

  it("rejects the removed Agent creation shape", async () => {
    const result = await taskCreateTool.execute(
      { type: "local_agent", description: "review", prompt: "review this" },
      { cwd: process.cwd() },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Use Agent") });
  });

  it("returns a shell jobId that can be controlled through Jobs", async () => {
    const cwd = temporaryDirectory();
    const result = await taskCreateTool.execute(
      { description: "print output", command: 'node -e "process.stdout.write(\'ok\')"' },
      { cwd, sessionId: "session-1" },
    );
    const payload = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;

    expect(payload).toMatchObject({
      kind: "job",
      action: "created",
      jobKind: "shell",
      label: "print output",
      jobId: expect.any(String),
    });
    await expect(getTaskManager({ cwd, sessionId: "session-1" }).awaitTask(
      payload.jobId as string,
      { timeoutMs: 5_000 },
    )).resolves.toMatchObject({ status: "completed", output: expect.stringContaining("ok") });
  });
});

function temporaryDirectory(): string {
  const cwd = mkdtempSync(join(tmpdir(), "openharness-task-create-"));
  createdDirectories.push(cwd);
  return cwd;
}
