import { describe, expect, it, vi } from "vitest";

import { DaemonTerminalService } from "./daemon-terminal-service.js";

describe("DaemonTerminalService scoped environments", () => {
  it("opens a projectless Docker terminal through a terminal lease", async () => {
    const session = { id: "outside-1", cwd: process.cwd(), status: "idle" } as any;
    const signal = vi.fn(async () => {});
    const targetClose = vi.fn(async () => {});
    const leaseRelease = vi.fn(async () => {});
    const prepare = vi.fn(async () => ({
      command: "docker",
      args: ["exec", "-it", "container", "/bin/sh", "-i"],
      hostCwd: process.cwd(),
      executionCwd: "/workspace",
      shell: "/bin/sh",
      signal,
      close: targetClose,
    }));
    const acquireEnvironment = vi.fn(async () => ({
      workspace: { executionRoot: "/workspace" },
      terminal: { prepare },
      release: leaseRelease,
    } as any));
    const pty = fakePty();
    const service = new DaemonTerminalService({
      getProject: () => undefined,
      getSession: (id: string) => id === session.id ? session : undefined,
    } as any, {
      getSettingsForCwd: async () => ({ terminal: { dockerShell: "/bin/sh" } } as any),
      acquireEnvironment,
      spawnPty: vi.fn(() => pty.value),
    });

    const terminal = await service.create({
      scope: { kind: "session", sessionId: session.id },
      runtime: "sandbox",
      cols: 100,
      rows: 30,
    });

    expect(acquireEnvironment).toHaveBeenCalledWith(
      session,
      expect.any(Object),
      { kind: "terminal", id: terminal.id },
    );
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/workspace",
      shell: "/bin/sh",
    }));
    expect(terminal).toMatchObject({
      scope: { kind: "session", sessionId: session.id },
      sessionId: session.id,
      cwd: "/workspace",
    });
    expect(terminal).not.toHaveProperty("projectId");

    await service.close(terminal.id);
    expect(targetClose).toHaveBeenCalledOnce();
    expect(leaseRelease).toHaveBeenCalledOnce();
  });

  it("rejects legacy projectId that disagrees with the session", async () => {
    const session = { id: "s1", cwd: process.cwd(), projectId: "p1" } as any;
    const service = new DaemonTerminalService({
      getProject: () => undefined,
      getSession: () => session,
    } as any);

    await expect(service.create({
      scope: { kind: "session", sessionId: "s1" },
      projectId: "different",
      sessionId: "s1",
      runtime: "local",
      cols: 80,
      rows: 24,
    })).rejects.toThrow("does not belong to project different");
  });
});

function fakePty() {
  let exit: ((event: { exitCode: number }) => void) | undefined;
  return {
    value: {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(() => exit?.({ exitCode: 0 })),
      onData: vi.fn(() => ({ dispose() {} })),
      onExit: vi.fn((listener) => { exit = listener; return { dispose() {} }; }),
    } as any,
  };
}
