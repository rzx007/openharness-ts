import { spawn } from "node:child_process";
import type { Settings } from "@openharness/core";
import {
  SandboxPolicyDeniedError,
  type HostShellLauncher,
  type SandboxSession,
} from "@openharness/sandbox";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SHELL_TIMEOUT_MS,
  DefaultShellExecutor,
} from "../executor.js";

const posixShell: HostShellLauncher = { kind: "posix-sh" };

describe("DefaultShellExecutor.resolve", () => {
  it("resolves request defaults and host runner facts", async () => {
    const executor = new DefaultShellExecutor({ resolveHostShell: () => posixShell });

    const spec = await executor.resolve({ command: "echo hello" }, {
      cwd: "C:\\workspace",
      sessionId: "session-1",
      settings: settings({ enabled: false }),
    });

    expect(spec).toMatchObject({
      command: "echo hello",
      cwd: "C:\\workspace",
      sessionId: "session-1",
      timeoutMs: DEFAULT_SHELL_TIMEOUT_MS,
      maxOutputChars: 12_000,
      hostShell: posixShell,
      runner: { mode: "host", fallbackToHost: false },
    });
  });

  it("records an active Docker sandbox as the resolved runner", async () => {
    const executor = new DefaultShellExecutor({
      resolveHostShell: () => posixShell,
      getActiveSession: () => activeDockerSession(),
    });

    const spec = await executor.resolve({
      command: "pwd",
      workdir: "D:\\project",
      timeoutMs: 5_000,
      env: { CI: "1" },
    }, {
      cwd: "D:\\workspace",
      sessionId: "session-2",
      settings: settings({ enabled: true, backend: "docker" }),
    });

    expect(spec).toMatchObject({
      cwd: "D:\\project",
      timeoutMs: 5_000,
      env: { CI: "1" },
      runner: {
        mode: "sandbox-active",
        backend: "docker",
        fallbackToHost: false,
      },
    });
  });

  it("makes sandbox fallback explicit when no Docker session is active", async () => {
    const executor = new DefaultShellExecutor({
      resolveHostShell: () => posixShell,
      getActiveSession: () => null,
    });

    const preferred = await executor.resolve({ command: "pwd" }, {
      cwd: "D:\\workspace",
      settings: settings({ enabled: true, backend: "docker", failIfUnavailable: false }),
    });
    const required = await executor.resolve({ command: "pwd" }, {
      cwd: "D:\\workspace",
      settings: settings({ enabled: true, backend: "docker", failIfUnavailable: true }),
    });

    expect(preferred.runner).toEqual({
      mode: "sandbox-preferred",
      backend: "docker",
      fallbackToHost: true,
    });
    expect(required.runner).toEqual({
      mode: "sandbox-required",
      backend: "docker",
      fallbackToHost: false,
    });
  });
});

describe("DefaultShellExecutor.run", () => {
  it("returns a structured command failure", async () => {
    const executor = processExecutor("process.stdout.write('bad command'); process.exit(3)");
    const spec = await executor.resolve({ command: "ignored" }, { cwd: process.cwd() });

    const result = await executor.run(spec);

    expect(result).toMatchObject({
      status: "failed",
      failureKind: "command",
      exitCode: 3,
      output: "bad command",
    });
  });

  it("returns a structured runner failure when process startup fails", async () => {
    const executor = new DefaultShellExecutor({
      resolveHostShell: () => posixShell,
      createProcess: async () => {
        throw new Error("runner unavailable");
      },
    });
    const spec = await executor.resolve({ command: "ignored" }, { cwd: process.cwd() });

    const result = await executor.run(spec);

    expect(result).toMatchObject({
      status: "failed",
      failureKind: "runner",
      exitCode: null,
      output: "runner unavailable",
      runnerError: { name: "Error", message: "runner unavailable" },
    });
  });

  it("keeps policy denial separate from runner startup failure", async () => {
    const executor = new DefaultShellExecutor({
      resolveHostShell: () => posixShell,
      createProcess: async () => {
        throw new SandboxPolicyDeniedError("execution_denied", "execute", "execution denied");
      },
    });
    const spec = await executor.resolve({ command: "ignored" }, { cwd: process.cwd() });

    const result = await executor.run(spec);

    expect(result).toMatchObject({
      status: "failed",
      failureKind: "policy",
      exitCode: null,
      output: "execution denied",
    });
  });

  it("bounds retained output while recording truncation", async () => {
    const executor = processExecutor("process.stdout.write('a'.repeat(200))");
    const spec = await executor.resolve({
      command: "ignored",
      maxOutputChars: 32,
    }, { cwd: process.cwd() });

    const result = await executor.run(spec);

    expect(result.status).toBe("completed");
    expect(result.outputTruncated).toBe(true);
    expect(result.output.length).toBe(33);
  });

  it("does not start a process when already interrupted", async () => {
    const createProcess = vi.fn();
    const executor = new DefaultShellExecutor({
      resolveHostShell: () => posixShell,
      createProcess,
    });
    const spec = await executor.resolve({ command: "ignored" }, { cwd: process.cwd() });
    const controller = new AbortController();
    controller.abort();

    const result = await executor.run(spec, controller.signal);

    expect(result).toMatchObject({
      status: "interrupted",
      failureKind: "interrupted",
      exitCode: null,
    });
    expect(createProcess).not.toHaveBeenCalled();
  });
});

function processExecutor(script: string): DefaultShellExecutor {
  return new DefaultShellExecutor({
    resolveHostShell: () => posixShell,
    createProcess: async (_command, options) => spawn(process.execPath, ["-e", script], {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: options.stdio,
    }),
  });
}

function activeDockerSession(): SandboxSession {
  return {
    backend: "docker",
    cwd: "D:\\project",
    active: true,
    async start() {},
    async stop() {},
  };
}

function settings(sandbox: Settings["sandbox"]): Settings {
  return {
    model: "test",
    apiFormat: "openai",
    maxTurns: 1,
    permission: { mode: "default" },
    sandbox,
  };
}
