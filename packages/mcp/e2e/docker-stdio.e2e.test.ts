import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Settings } from "@openharness/core";
import {
  hostPathToContainerPath,
  startSandboxRuntime,
  type StartedSandboxRuntime,
} from "@openharness/sandbox";
import { SandboxStdioClientTransport } from "../src/sandbox-stdio-transport.js";

const image = process.env.OPENHARNESS_E2E_DOCKER_MCP_IMAGE ??
  process.env.OPENHARNESS_E2E_DOCKER_IMAGE ??
  "openharness-sandbox:latest";
const autoBuildImage = process.env.OPENHARNESS_E2E_DOCKER_MCP_IMAGE === undefined &&
  process.env.OPENHARNESS_E2E_DOCKER_IMAGE === undefined;
const runDocker = dockerAvailable();
const runWithImage = runDocker && (autoBuildImage || dockerImageAvailable(image));
const maybeDescribe = runWithImage ? describe : describe.skip;

let runtime: StartedSandboxRuntime | undefined;

afterEach(async () => {
  await runtime?.stop();
  runtime = undefined;
});

beforeAll(() => {
  if (!runDocker) {
    console.warn("[mcp:e2e:docker] skipped: Docker CLI or daemon is unavailable");
    return;
  }
  if (!runWithImage) {
    console.warn(`[mcp:e2e:docker] skipped: Docker image ${image} is not available`);
  }
});

maybeDescribe("docker MCP stdio e2e", () => {
  it("starts stdio servers through the Docker sandbox runtime", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "oh-mcp-docker-e2e-"));
    const sessionId = `mcp-docker-${Date.now()}`;
    const settings = dockerSettings();
    const serverPath = join(cwd, "server.cjs");
    try {
      await writeFile(join(cwd, "marker.txt"), "mounted", "utf8");
      await writeFile(serverPath, MCP_STDIO_SERVER, "utf8");

      runtime = await startSandboxRuntime({ settings, cwd, sessionId });
      expect(runtime.status).toMatchObject({
        state: "active",
        active: true,
        backend: "docker",
      });

      const transport = new SandboxStdioClientTransport({
        command: "node",
        args: ["server.cjs"],
        cwd,
        settings,
        sessionId,
      });
      const responsePromise = nextMessage(transport);
      await transport.start();
      await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });

      const response = await responsePromise;
      expect(response).toMatchObject({ jsonrpc: "2.0", id: 1 });
      const result = (response as { result?: { cwd?: string; marker?: boolean } }).result;
      expect(result?.cwd).toBe(hostPathToContainerPath(cwd, cwd));
      expect(result?.marker).toBe(true);

      await transport.close();
    } finally {
      await runtime?.stop();
      runtime = undefined;
      await rm(cwd, { recursive: true, force: true });
    }
  }, 60_000);
});

const MCP_STDIO_SERVER = `
const fs = require("node:fs");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: request.id,
    result: {
      cwd: process.cwd(),
      marker: fs.existsSync("marker.txt"),
    },
  }) + "\\n");
});
`.trim();

function nextMessage(transport: SandboxStdioClientTransport): Promise<JSONRPCMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("MCP stdio response timed out"));
    }, 10_000);
    transport.onerror = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    transport.onmessage = (message) => {
      clearTimeout(timer);
      resolve(message);
    };
  });
}

function dockerSettings(): Settings {
  return {
    model: "e2e",
    apiFormat: "openai",
    maxTurns: 1,
    permission: { mode: "default" },
    sandbox: {
      enabled: true,
      backend: "docker",
      failIfUnavailable: true,
      network: { mode: "none" },
      docker: {
        image,
        autoBuildImage,
        reuseContainer: false,
      },
    },
  };
}

function dockerAvailable(): boolean {
  if (!hasCommand("docker")) return false;
  const result = spawnSync("docker", ["info"], {
    windowsHide: true,
    stdio: "ignore",
  });
  return result.status === 0;
}

function dockerImageAvailable(candidate: string): boolean {
  const result = spawnSync("docker", ["image", "inspect", candidate], {
    windowsHide: true,
    stdio: "ignore",
  });
  return result.status === 0;
}

function hasCommand(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    windowsHide: true,
    stdio: "ignore",
  });
  return result.status === 0;
}
