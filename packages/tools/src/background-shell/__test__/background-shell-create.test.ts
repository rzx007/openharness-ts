import { describe, expect, it, vi } from "vitest";

import { backgroundShellCreateTool } from "../background-shell-tools.js";

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

  it("delegates creation to the host and returns its durable job id", async () => {
    const create = vi.fn(async () => ({ jobId: "task-durable", label: "print output" }));
    const result = await backgroundShellCreateTool.execute(
      { description: "print output", command: 'node -e "process.stdout.write(\'ok\')"' },
      {
        cwd: "/repo",
        sessionId: "session-1",
        settings: { model: "test" } as any,
        backgroundShell: { create },
      },
    );
    const payload = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
    expect(payload).toMatchObject({
      kind: "job",
      action: "created",
      jobKind: "shell",
      label: "print output",
      jobId: "task-durable",
    });
    expect(create).toHaveBeenCalledWith({
      cwd: "/repo",
      sessionId: "session-1",
      command: 'node -e "process.stdout.write(\'ok\')"',
      description: "print output",
      settings: { model: "test" },
    });
  });

  it("fails before launching when no host is configured", async () => {
    const result = await backgroundShellCreateTool.execute(
      { description: "server", command: "npm run dev" },
      { cwd: "/repo", sessionId: "session-1" },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: "Background shell host is not configured." }],
    });
  });
});
