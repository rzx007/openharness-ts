import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getDetachedProcessSupervisor,
  resetExecutionRuntimes,
} from "@openharness/services/executions";
import { afterEach, describe, expect, it } from "vitest";

import { backgroundShellCreateTool } from "../background-shell-tools.js";

const createdDirectories: string[] = [];

afterEach(() => {
  for (const cwd of createdDirectories.splice(0)) {
    resetExecutionRuntimes({ cwd, sessionId: "session-1" });
    rmSync(cwd, { recursive: true, force: true });
  }
});

describe("BackgroundShellCreate", () => {
  it("exposes only background-shell inputs", () => {
    const schema = backgroundShellCreateTool.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(["description", "command"]);
    expect(schema.required).toEqual(["description", "command"]);
  });

  it("rejects the removed Agent creation shape", async () => {
    const result = await backgroundShellCreateTool.execute(
      { type: "local_agent", description: "review", prompt: "review this" },
      { cwd: process.cwd() },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Use Agent") });
  });

  it("returns a shell jobId controlled by the process supervisor", async () => {
    const cwd = temporaryDirectory();
    const result = await backgroundShellCreateTool.execute(
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
    await expect(getDetachedProcessSupervisor({ cwd, sessionId: "session-1" }).awaitExecution(
      payload.jobId as string,
      { timeoutMs: 5_000 },
    )).resolves.toMatchObject({ status: "completed", output: expect.stringContaining("ok") });
  });
});

function temporaryDirectory(): string {
  const cwd = mkdtempSync(join(tmpdir(), "openharness-background-shell-create-"));
  createdDirectories.push(cwd);
  return cwd;
}
