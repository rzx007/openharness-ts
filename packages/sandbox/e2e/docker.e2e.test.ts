import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createShellProcess,
  SandboxUnavailableError,
  startSandboxRuntime,
  type StartedSandboxRuntime,
} from "../src/index.js";
import {
  baseSettings,
  collectProcess,
  dockerAvailable,
  dockerImageAvailable,
} from "./helpers.js";

const image = process.env.OPENHARNESS_E2E_DOCKER_IMAGE ?? "node:22-bookworm";
const runDocker = dockerAvailable();
const runWithImage = runDocker && dockerImageAvailable(image);
const maybeDescribe = runWithImage ? describe : describe.skip;

let runtime: StartedSandboxRuntime | undefined;

afterEach(async () => {
  await runtime?.stop();
  runtime = undefined;
});

beforeAll(() => {
  if (!runDocker) {
    console.warn("[sandbox:e2e:docker] skipped: Docker CLI or daemon is unavailable");
    return;
  }
  if (!runWithImage) {
    console.warn(`[sandbox:e2e:docker] skipped: Docker image ${image} is not available`);
  }
});

maybeDescribe("docker sandbox e2e", () => {
  it("starts a docker runtime and executes shell commands inside the mounted workspace", async () => {
    runtime = await startSandboxRuntime({
      settings: {
        ...baseSettings,
        sandbox: {
          enabled: true,
          backend: "docker",
          failIfUnavailable: true,
          network: { mode: "none" },
          docker: { image, autoBuildImage: false },
        },
      },
      cwd: process.cwd(),
      sessionId: `e2e-docker-${Date.now()}`,
    });

    expect(runtime.status).toMatchObject({
      state: "active",
      active: true,
      backend: "docker",
      networkMode: "none",
    });
    expect(runtime.status.containerName).toContain("openharness-sandbox-e2e-docker");

    const child = await createShellProcess("pwd && test -f package.json && node -e \"console.log('node-ok')\"", {
      cwd: process.cwd(),
      settings: {
        ...baseSettings,
        sandbox: {
          enabled: true,
          backend: "docker",
          failIfUnavailable: true,
          network: { mode: "none" },
          docker: { image, autoBuildImage: false },
        },
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = await collectProcess(child);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("node-ok");
  }, 60_000);

  it("blocks outbound network when Docker network mode is none", async () => {
    runtime = await startSandboxRuntime({
      settings: {
        ...baseSettings,
        sandbox: {
          enabled: true,
          backend: "docker",
          failIfUnavailable: true,
          network: { mode: "none" },
          docker: { image, autoBuildImage: false },
        },
      },
      cwd: process.cwd(),
      sessionId: `e2e-docker-none-${Date.now()}`,
    });

    const child = await createShellProcess(
      "node -e \"fetch('https://example.com').then(()=>process.exit(0)).catch(()=>process.exit(7))\"",
      {
        cwd: process.cwd(),
        settings: {
          ...baseSettings,
          sandbox: {
            enabled: true,
            backend: "docker",
            failIfUnavailable: true,
            network: { mode: "none" },
            docker: { image, autoBuildImage: false },
          },
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const result = await collectProcess(child);

    expect(result.exitCode).toBe(7);
  }, 60_000);

  it("fails closed for proxy mode without proxy env", async () => {
    await expect(startSandboxRuntime({
      settings: {
        ...baseSettings,
        sandbox: {
          enabled: true,
          backend: "docker",
          failIfUnavailable: true,
          network: { mode: "proxy" },
          docker: { image, autoBuildImage: false },
        },
      },
      cwd: process.cwd(),
      sessionId: `e2e-docker-proxy-${Date.now()}`,
    })).rejects.toThrow(SandboxUnavailableError);
  }, 60_000);

  it.skipIf(process.env.OPENHARNESS_E2E_DOCKER_NETWORK !== "1")(
    "allows outbound network when Docker bridge networking is enabled",
    async () => {
      runtime = await startSandboxRuntime({
        settings: {
          ...baseSettings,
          sandbox: {
            enabled: true,
            backend: "docker",
            failIfUnavailable: true,
            network: { mode: "bridge" },
            docker: { image, autoBuildImage: false },
          },
        },
        cwd: process.cwd(),
        sessionId: `e2e-docker-bridge-${Date.now()}`,
      });

      const child = await createShellProcess(
        "node -e \"fetch('https://example.com').then(r=>{console.log(r.status); process.exit(r.status === 200 ? 0 : 1)}).catch(e=>{console.error(e); process.exit(1)})\"",
        {
          cwd: process.cwd(),
          settings: {
            ...baseSettings,
            sandbox: {
              enabled: true,
              backend: "docker",
              failIfUnavailable: true,
              network: { mode: "bridge" },
              docker: { image, autoBuildImage: false },
            },
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const result = await collectProcess(child);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("200");
    },
    60_000,
  );
});
