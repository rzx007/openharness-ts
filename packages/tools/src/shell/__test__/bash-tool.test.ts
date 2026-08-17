import { resolveSandboxPolicy, type HostShellLauncher } from "@openharness/sandbox";
import { describe, expect, it, vi } from "vitest";
import { createBashTool } from "../bash.js";
import type {
  ShellExecContext,
  ShellExecRequest,
  ShellExecSpec,
  ShellExecutor,
  ShellRunResult,
} from "../types.js";

const posixShell: HostShellLauncher = { kind: "posix-sh" };

describe("createBashTool", () => {
  it("resolves raw input before running the command", async () => {
    const resolve = vi.fn(async (request: ShellExecRequest, context: ShellExecContext) => {
      expect(request).toEqual({
        command: "echo hello",
        timeoutMs: 2_000,
        workdir: "D:\\project",
      });
      expect(context).toMatchObject({ cwd: "D:\\workspace", sessionId: "session-1" });
      return spec({ command: request.command, cwd: request.workdir, timeoutMs: request.timeoutMs });
    });
    const run = vi.fn(async () => result({ output: "hello" }));
    const tool = createBashTool({ resolve, run });

    const toolResult = await tool.execute({
      command: "echo hello",
      timeout: 2_000,
      workdir: "D:\\project",
    }, {
      cwd: "D:\\workspace",
      sessionId: "session-1",
    });

    expect(run).toHaveBeenCalledOnce();
    expect(toolResult).toEqual({
      content: [{ type: "text", text: "hello" }],
      isError: false,
    });
  });

  it("maps runner failures to the existing Bash error surface", async () => {
    const executor = fakeExecutor(result({
      status: "failed",
      failureKind: "runner",
      output: "Docker sandbox session is not running",
      exitCode: null,
      runnerError: {
        name: "SandboxUnavailableError",
        message: "Docker sandbox session is not running",
      },
    }));
    const tool = createBashTool(executor);

    const toolResult = await tool.execute({ command: "pwd" }, { cwd: process.cwd() });

    expect(toolResult).toEqual({
      content: [{ type: "text", text: "Docker sandbox session is not running" }],
      isError: true,
    });
  });

  it("renders timeout partial output from the resolved timeout", async () => {
    const executor = fakeExecutor(result({
      status: "timed_out",
      failureKind: "timeout",
      output: "partial marker",
      exitCode: null,
    }), spec({ timeoutMs: 750 }));
    const tool = createBashTool(executor);

    const toolResult = await tool.execute({ command: "slow", timeout: 750 }, { cwd: process.cwd() });

    expect(toolResult.isError).toBe(true);
    expect(toolResult.content[0]).toMatchObject({
      type: "text",
      text: "Command timed out after 750 ms.\n\nPartial output:\npartial marker",
    });
  });

  it("allows POSIX syntax when an active Docker runner will execute it", async () => {
    const run = vi.fn(async () => result({ output: "docker-ok" }));
    const executor: ShellExecutor = {
      async resolve(request) {
        return spec({
          command: request.command,
          hostShell: { kind: "powershell", bin: "powershell.exe" },
          runner: { mode: "sandbox-active", backend: "docker", fallbackToHost: false },
        });
      },
      run,
    };
    const tool = createBashTool(executor);

    const toolResult = await tool.execute({ command: "ls -la /tmp" }, { cwd: process.cwd() });

    expect(run).toHaveBeenCalledOnce();
    expect(toolResult.isError).toBe(false);
  });

  it("keeps host shell dialect diagnostics before execution", async () => {
    const run = vi.fn(async () => result());
    const executor: ShellExecutor = {
      async resolve(request) {
        return spec({
          command: request.command,
          hostShell: { kind: "powershell", bin: "powershell.exe" },
        });
      },
      run,
    };
    const tool = createBashTool(executor);

    const toolResult = await tool.execute({ command: "ls -la /tmp" }, { cwd: process.cwd() });

    expect(run).not.toHaveBeenCalled();
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Shell dialect mismatch"),
    });
  });
});

function fakeExecutor(
  runResult: ShellRunResult,
  resolvedSpec = spec(),
): ShellExecutor {
  return {
    async resolve(request) {
      return { ...resolvedSpec, command: request.command };
    },
    async run() {
      return runResult;
    },
  };
}

function spec(overrides: Partial<ShellExecSpec> = {}): ShellExecSpec {
  return {
    command: "echo hello",
    cwd: process.cwd(),
    timeoutMs: 120_000,
    maxOutputChars: 12_000,
    policy: resolveSandboxPolicy({ cwd: process.cwd(), config: { enabled: false } }),
    hostShell: posixShell,
    runner: { mode: "host", fallbackToHost: false },
    ...overrides,
  };
}

function result(overrides: Partial<ShellRunResult> = {}): ShellRunResult {
  return {
    status: "completed",
    output: "",
    outputTruncated: false,
    exitCode: 0,
    ...overrides,
  };
}
