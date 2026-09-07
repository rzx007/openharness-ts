import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkspaceBinding } from "@openharness/environment";

import { resolveExecutionEnvironmentConfig } from "./execution-config.js";
import { createExecutionEnvironment } from "./execution-environment.js";

describe("createExecutionEnvironment", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("creates a fail-closed WSL process and terminal environment", async () => {
    const workspace = "D:\\Code Space\\ohs";
    const spawnWslProcess = vi.fn(() => ({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      stdin: { write: vi.fn(), end: vi.fn() },
      once: vi.fn(),
    }) as any);
    const settings = baseSettings();
    const handle = await createExecutionEnvironment({
      config: {
        mode: "wsl",
        kind: "wsl",
        failClosed: true,
        cwd: workspace,
        sandbox: {} as any,
      },
      settings,
      binding: createWorkspaceBinding({
        kind: "wsl",
        hostRoot: workspace,
        executionRoot: "/mnt/d/Code Space/ohs",
      }),
      sessionId: "session-wsl",
      userSkillsRoot: "C:\\Users\\me\\.openharness-ts\\skills",
    }, {
      preflightWsl: vi.fn(async () => {}),
      spawnWslProcess,
    });

    expect(handle.info).toMatchObject({ kind: "wsl", executionOs: "Linux", pathStyle: "posix" });
    await handle.process.execShell("pwd");
    expect(spawnWslProcess).toHaveBeenCalledWith(expect.objectContaining({
      argv: ["/bin/sh", "-lc", "pwd"],
      cwd: "/mnt/d/Code Space/ohs",
    }));
    await expect(handle.terminal.prepare({ cols: 80, rows: 24 })).resolves.toMatchObject({
      command: "wsl.exe",
      args: ["--cd", "/mnt/d/Code Space/ohs"],
      executionCwd: "/mnt/d/Code Space/ohs",
    });
  });

  it("publishes Docker facts only after the runtime is ready", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ohs-environment-workspace-"));
    const skills = join(workspace, "user-skills");
    roots.push(workspace);
    const events: string[] = [];
    const stop = vi.fn(async () => {});
    const settings = baseSettings({
      sandbox: { enabled: true, backend: "docker" },
    });

    const handle = await createExecutionEnvironment(
      {
        config: resolveExecutionEnvironmentConfig({
          surface: "desktop_managed",
          settings,
          cwd: workspace,
        }),
        settings,
        binding: createWorkspaceBinding({
          kind: "docker",
          hostRoot: workspace,
          executionRoot: "/workspace",
        }),
        sessionId: "session-1",
        userSkillsRoot: skills,
        onEvent: (event) => events.push(event),
      },
      {
        startSandboxRuntime: vi.fn(async (input) => {
          expect(input.managedMounts).toHaveLength(2);
          return {
            status: {
              state: "active",
              enabled: true,
              active: true,
              backend: "docker",
              platform: "windows",
              containerCwd: "/workspace",
              networkMode: "none",
            },
            stop,
            stopSync: vi.fn(),
          };
        }),
      },
    );

    expect(events).toEqual(["preflight", "start", "probe", "ready"]);
    expect(handle.info).toMatchObject({
      kind: "docker",
      hostOs: "Windows",
      executionOs: "Linux",
      shell: "/bin/sh",
      pathStyle: "posix",
      cwd: "/workspace",
      mounts: [
        { path: "/workspace", mode: "rw", purpose: "workspace" },
        {
          path: "/opt/openharness/skills",
          mode: "rw",
          purpose: "user_skills",
        },
      ],
    });

    await handle.release();
    await handle.release();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("prepares Docker terminals only for mounted cwd and configured shells", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ohs-environment-terminal-"));
    roots.push(workspace);
    const preparePtyTarget = vi.fn(async (input) => ({
      command: "docker",
      args: ["exec", "-it"],
      hostCwd: workspace,
      executionCwd: input.cwd,
      shell: input.shell,
      signal: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    }));
    const settings = baseSettings({
      terminal: { dockerShell: "/bin/bash" },
      sandbox: { enabled: true, backend: "docker" },
    });
    const handle = await createExecutionEnvironment({
      config: resolveExecutionEnvironmentConfig({ surface: "desktop_managed", settings, cwd: workspace }),
      settings,
      binding: createWorkspaceBinding({ kind: "docker", hostRoot: workspace, executionRoot: "/workspace" }),
      sessionId: "session-terminal",
      userSkillsRoot: join(workspace, "skills"),
    }, {
      startSandboxRuntime: vi.fn(async () => ({
        status: { state: "active", enabled: true, active: true, backend: "docker" },
        session: { preparePtyTarget } as any,
        stop: vi.fn(async () => {}),
        stopSync: vi.fn(),
      })),
    });

    await handle.terminal.prepare({ cwd: "/workspace/src", cols: 100, rows: 30 });
    expect(preparePtyTarget).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/workspace/src",
      shell: "/bin/bash",
    }));
    await expect(handle.terminal.prepare({ cwd: "/etc", cols: 100, rows: 30 }))
      .rejects.toThrow("outside the mounted execution roots");
  });

  it("fails closed when Docker startup fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ohs-environment-fail-"));
    roots.push(workspace);
    const settings = baseSettings({
      sandbox: { enabled: true, backend: "docker" },
    });

    await expect(
      createExecutionEnvironment(
        {
          config: resolveExecutionEnvironmentConfig({
            surface: "desktop_managed",
            settings,
            cwd: workspace,
          }),
          settings,
          binding: createWorkspaceBinding({
            kind: "docker",
            hostRoot: workspace,
            executionRoot: "/workspace",
          }),
          sessionId: "session-fail",
          userSkillsRoot: join(workspace, "skills"),
        },
        {
          startSandboxRuntime: vi.fn(async () => {
            throw new Error("Docker daemon unavailable");
          }),
        },
      ),
    ).rejects.toThrow("Docker daemon unavailable");
  });
});

function baseSettings(overrides: Record<string, unknown> = {}) {
  return {
    model: "test",
    apiFormat: "openai" as const,
    maxTurns: 1,
    permission: { mode: "default" as const },
    ...overrides,
  };
}
