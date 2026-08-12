import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import type { Settings } from "@openharness/core";

export const baseSettings = {
  model: "e2e",
  apiFormat: "openai",
  maxTurns: 1,
  permission: { mode: "default" },
} satisfies Omit<Settings, "sandbox">;

export function hasCommand(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    windowsHide: true,
    stdio: "ignore",
  });
  return result.status === 0;
}

export function dockerAvailable(): boolean {
  if (!hasCommand("docker")) return false;
  const result = spawnSync("docker", ["info"], {
    windowsHide: true,
    stdio: "ignore",
  });
  return result.status === 0;
}

export function dockerImageAvailable(image: string): boolean {
  const result = spawnSync("docker", ["image", "inspect", image], {
    windowsHide: true,
    stdio: "ignore",
  });
  return result.status === 0;
}

export function dockerContainerExists(containerName: string): boolean {
  const result = spawnSync("docker", ["container", "inspect", containerName], {
    windowsHide: true,
    stdio: "ignore",
  });
  return result.status === 0;
}

export function dockerContainerRunning(containerName: string): boolean {
  const result = spawnSync("docker", [
    "container",
    "inspect",
    "-f",
    "{{.State.Running}}",
    containerName,
  ], {
    windowsHide: true,
    encoding: "utf-8",
  });
  return result.status === 0 && result.stdout.trim() === "true";
}

export function dockerProcessRunning(containerName: string, pid: number): boolean {
  const result = spawnSync("docker", [
    "exec",
    containerName,
    "/bin/kill",
    "-0",
    String(pid),
  ], {
    windowsHide: true,
    stdio: "ignore",
  });
  return result.status === 0;
}

export function dockerRmForce(containerName: string): void {
  spawnSync("docker", ["rm", "-f", containerName], {
    windowsHide: true,
    stdio: "ignore",
  });
}

export function collectProcess(child: ChildProcess): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({ exitCode: 1, stdout, stderr: stderr || error.message });
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}
