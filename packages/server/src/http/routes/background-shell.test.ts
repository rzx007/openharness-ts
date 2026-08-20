import { describe, expect, it, vi } from "vitest";

import { createBackgroundShellRoutes } from "./background-shell.js";

describe("background shell routes", () => {
  it("creates a shell and returns its normalized Job snapshot", async () => {
    const create = vi.fn(async () => ({ task: { id: "task-1" } }));
    const read = vi.fn(async () => ({
      text: "",
      cursor: 1,
      truncated: false,
      snapshot: {
        id: "task-1",
        kind: "shell" as const,
        label: "pnpm test",
        ownerSession: "s1",
        status: "running" as const,
        capabilities: { read: true, wait: true, send: false, cancel: true },
        cwd: "/repo",
        startedAt: 1,
        updatedAt: 1,
      },
    }));
    const app = createBackgroundShellRoutes({ tasks: { create }, jobs: { read } });

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", command: "  pnpm test  " }),
    });

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith({
      sessionId: "s1",
      cwd: undefined,
      command: "pnpm test",
      description: undefined,
    });
    expect(read).toHaveBeenCalledWith({ sessionId: "s1", jobId: "task-1" });
    await expect(response.json()).resolves.toMatchObject({
      jobId: "task-1",
      snapshot: { id: "task-1", kind: "shell", status: "running" },
    });
  });

  it.each([
    [{ command: "echo hi" }, "sessionId is required"],
    [{ sessionId: "s1", command: "   " }, "command is required"],
  ])("rejects invalid input %#", async (body, message) => {
    const app = createBackgroundShellRoutes({
      tasks: { create: vi.fn() },
      jobs: { read: vi.fn() },
    });
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: message });
  });
});
