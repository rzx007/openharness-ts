import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Settings } from "@openharness/core";
import { createWorkspaceBinding } from "@openharness/environment";
import {
  createExecutionEnvironment,
  dockerContainerName,
  ExecutionEnvironmentManager,
  resolveExecutionEnvironmentConfig,
} from "@openharness/sandbox";
import { LocalTerminalProvider } from "../src/local-terminal-provider.js";

const image = process.env.OPENHARNESS_E2E_DOCKER_PTY_IMAGE ?? "openharness-sandbox:latest";
const runDocker = dockerAvailable();
const maybeDescribe = runDocker ? describe : describe.skip;

beforeAll(() => {
  if (!runDocker) console.warn("[terminal-node:e2e:docker] skipped: Docker CLI or daemon is unavailable");
});

maybeDescribe("Docker PTY shared environment e2e", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "oh-terminal-docker-pty-"));
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("supports tty, cwd, resize, Ctrl-C, EOF, and lease isolation", async () => {
    const settings = dockerSettings();
    const sessionId = `pty-${Date.now()}`;
    const manager = new ExecutionEnvironmentManager();
    const create = async () => await createExecutionEnvironment({
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
      sessionId,
      userSkillsRoot: join(workspace, "skills"),
    });
    const agentLease = await manager.acquire({
      ownerId: `session:${sessionId}`,
      configHash: "pty-e2e",
      consumer: { kind: "agent", id: sessionId },
      create,
    });
    const terminalLease = await manager.acquire({
      ownerId: `session:${sessionId}`,
      configHash: "pty-e2e",
      consumer: { kind: "terminal", id: "terminal" },
      create,
    });
    expect(terminalLease.environmentId).toBe(agentLease.environmentId);

    let activeTerminalLease = terminalLease;
    const provider = new LocalTerminalProvider({
      resolveCwd: async () => workspace,
      resolveTarget: async (input) => {
        const ownedLease = activeTerminalLease;
        const target = await ownedLease.terminal.prepare({
          cwd: "/workspace",
          shell: "/bin/sh",
          cols: input.cols,
          rows: input.rows,
        });
        return {
          ...target,
          close: async () => {
            await target.close();
            await ownedLease.release();
          },
        };
      },
    });

    try {
      const terminal = await provider.create({
        scope: { kind: "session", sessionId },
        runtime: "sandbox",
        cols: 100,
        rows: 30,
      });
      await provider.write({
        terminalId: terminal.id,
        data: "tty -s && echo __TTY_OK__; printf '__PWD__:%s\\n' \"$(pwd)\"\r",
      });
      let output = await waitForOutput(provider, terminal.id, "__PWD__:/workspace");
      expect(output).toContain("__TTY_OK__");

      await provider.resize({ terminalId: terminal.id, cols: 120, rows: 40 });
      await provider.write({ terminalId: terminal.id, data: "stty size | sed 's/^/__SIZE__:/'\r" });
      output = await waitForOutput(provider, terminal.id, "__SIZE__:40 120");
      expect(output).toContain("__SIZE__:40 120");

      await provider.write({ terminalId: terminal.id, data: "sleep 30\r" });
      await delay(200);
      await provider.signal({ terminalId: terminal.id, signal: "interrupt" });
      await provider.write({ terminalId: terminal.id, data: "echo __AFTER_INTERRUPT__\r" });
      output = await waitForOutput(provider, terminal.id, "__AFTER_INTERRUPT__");
      expect(output).toContain("__AFTER_INTERRUPT__");

      await provider.signal({ terminalId: terminal.id, signal: "eof" });
      expect((await provider.wait({ terminalId: terminal.id, timeoutMs: 10_000 })).timedOut)
        .toBe(false);

      activeTerminalLease = await manager.acquire({
        ownerId: `session:${sessionId}`,
        configHash: "pty-e2e",
        consumer: { kind: "terminal", id: "terminate-terminal" },
        create,
      });
      const terminateTerminal = await provider.create({
        scope: { kind: "session", sessionId },
        runtime: "sandbox",
        cols: 100,
        rows: 30,
      });
      await provider.write({ terminalId: terminateTerminal.id, data: "sleep 30\r" });
      await delay(200);
      await provider.kill(terminateTerminal.id);
      expect((await provider.list()).find((item) => item.id === terminateTerminal.id)?.status)
        .toMatch(/stopping|killed/);
      await waitFor(
        () => manager.inspect(`session:${sessionId}`)?.leaseCount === 1,
        10_000,
      );

      const process = await agentLease.process.execShell("echo __AGENT_STILL_RUNNING__");
      let agentOutput = "";
      process.onOutput((chunk) => { agentOutput += new TextDecoder().decode(chunk); });
      expect((await process.wait()).exitCode).toBe(0);
      expect(agentOutput).toContain("__AGENT_STILL_RUNNING__");
    } finally {
      await provider.dispose();
      await agentLease.release();
      await manager.dispose();
    }

    const containerName = dockerContainerName(sessionId);
    await waitFor(() => !dockerContainerExists(containerName), 10_000);
  }, 90_000);
});

async function waitForOutput(
  provider: LocalTerminalProvider,
  terminalId: string,
  marker: string,
): Promise<string> {
  let output = "";
  try {
    await waitFor(async () => {
      output = (await provider.read({ terminalId, maxChars: 50_000 })).data;
      return output.includes(marker);
    }, 10_000);
  } catch {
    throw new Error(`terminal output did not contain ${marker}: ${JSON.stringify(output)}`);
  }
  return output;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dockerSettings(): Settings {
  return {
    model: "e2e",
    apiFormat: "openai",
    maxTurns: 1,
    permission: { mode: "default" },
    terminal: { dockerShell: "/bin/sh" },
    sandbox: {
      enabled: true,
      backend: "docker",
      failIfUnavailable: true,
      network: { mode: "none" },
      docker: { image, autoBuildImage: true, reuseContainer: false },
    },
  };
}

function dockerAvailable(): boolean {
  return spawnSync("docker", ["info"], { windowsHide: true, stdio: "ignore" }).status === 0;
}

function dockerContainerExists(name: string): boolean {
  return spawnSync("docker", ["container", "inspect", name], {
    windowsHide: true,
    stdio: "ignore",
  }).status === 0;
}
