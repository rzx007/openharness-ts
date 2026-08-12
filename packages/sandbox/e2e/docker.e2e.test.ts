import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  createProcess,
  createShellProcess,
  SandboxUnavailableError,
  startSandboxRuntime,
  type StartedSandboxRuntime,
} from "../src/index.js";
import {
  baseSettings,
  collectProcess,
  dockerAvailable,
  dockerContainerExists,
  dockerContainerRunning,
  dockerProcessRunning,
  dockerImageAvailable,
  dockerRmForce,
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
  const reusablePrefix = `openharness-e2e-reuse-${process.pid}`;
  const tempPrefix = `openharness-e2e-temp-${process.pid}`;
  const ownedContainers = new Set<string>();

  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
    for (const containerName of ownedContainers) {
      dockerRmForce(containerName);
    }
    ownedContainers.clear();
  });

  it("starts a docker runtime and executes shell commands inside the mounted workspace", async () => {
    const sessionId = `e2e-docker-${Date.now()}`;
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
      sessionId,
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
      sessionId,
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

  it("preserves stdin for supervised docker argv processes", async () => {
    const sessionId = `e2e-docker-stdin-${Date.now()}`;
    const sandbox = {
      enabled: true,
      backend: "docker" as const,
      failIfUnavailable: true,
      network: { mode: "none" as const },
      docker: { image, autoBuildImage: false },
    };
    runtime = await startSandboxRuntime({
      settings: { ...baseSettings, sandbox },
      cwd: process.cwd(),
      sessionId,
    });

    const child = await createProcess(
      [
        "node",
        "-e",
        "let raw='';process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>process.stdout.write(JSON.parse(raw).op));",
      ],
      {
        cwd: process.cwd(),
        sessionId,
        settings: { ...baseSettings, sandbox },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const resultPromise = collectProcess(child);
    child.stdin?.end(JSON.stringify({ op: "writeText" }));

    const result = await resultPromise;
    expect(result).toMatchObject({ exitCode: 0, stdout: "writeText" });
  }, 60_000);

  it("reuses the same project container across runtime starts", async () => {
    const sandbox = {
      enabled: true,
      backend: "docker" as const,
      failIfUnavailable: true,
      network: { mode: "none" as const },
      docker: {
        image,
        autoBuildImage: false,
        reuseContainer: true,
        containerNamePrefix: reusablePrefix,
      },
    };

    runtime = await startSandboxRuntime({
      settings: { ...baseSettings, sandbox },
      cwd: process.cwd(),
      sessionId: `e2e-reuse-first-${Date.now()}`,
    });
    const containerName = runtime.status.containerName!;
    ownedContainers.add(containerName);
    expect(dockerContainerExists(containerName)).toBe(true);
    expect(dockerContainerRunning(containerName)).toBe(true);
    await runtime.stop();
    runtime = undefined;
    expect(dockerContainerExists(containerName)).toBe(true);

    runtime = await startSandboxRuntime({
      settings: { ...baseSettings, sandbox },
      cwd: process.cwd(),
      sessionId: `e2e-reuse-second-${Date.now()}`,
    });

    expect(runtime.status.containerName).toBe(containerName);
    expect(dockerContainerExists(containerName)).toBe(true);
    expect(dockerContainerRunning(containerName)).toBe(true);
  }, 60_000);

  it("fails fast when a reusable project container has stale config", async () => {
    const baseSandbox = {
      enabled: true,
      backend: "docker" as const,
      failIfUnavailable: true,
      network: { mode: "none" as const },
      docker: {
        image,
        autoBuildImage: false,
        reuseContainer: true,
        containerNamePrefix: `${reusablePrefix}-drift`,
      },
    };

    runtime = await startSandboxRuntime({
      settings: { ...baseSettings, sandbox: baseSandbox },
      cwd: process.cwd(),
      sessionId: `e2e-drift-first-${Date.now()}`,
    });
    const containerName = runtime.status.containerName!;
    ownedContainers.add(containerName);
    await runtime.stop();
    runtime = undefined;

    await expect(startSandboxRuntime({
      settings: {
        ...baseSettings,
        sandbox: {
          ...baseSandbox,
          docker: {
            ...baseSandbox.docker,
            dns: ["1.1.1.1"],
          },
        },
      },
      cwd: process.cwd(),
      sessionId: `e2e-drift-second-${Date.now()}`,
    })).rejects.toThrow("ohs sandbox rebuild");
  }, 60_000);

  it("removes temporary session containers after runtime stop", async () => {
    runtime = await startSandboxRuntime({
      settings: {
        ...baseSettings,
        sandbox: {
          enabled: true,
          backend: "docker",
          failIfUnavailable: true,
          network: { mode: "none" },
          docker: {
            image,
            autoBuildImage: false,
            reuseContainer: false,
            containerNamePrefix: tempPrefix,
          },
        },
      },
      cwd: process.cwd(),
      sessionId: `temp-${Date.now()}`,
    });
    const containerName = runtime.status.containerName!;
    expect(dockerContainerExists(containerName)).toBe(true);
    await runtime.stop();
    runtime = undefined;

    expect(dockerContainerExists(containerName)).toBe(false);
  }, 60_000);

  it("aborting a command removes its whole container process tree", async () => {
    const sessionId = `e2e-abort-${Date.now()}`;
    const sandbox = {
      enabled: true,
      backend: "docker" as const,
      failIfUnavailable: true,
      network: { mode: "none" as const },
      docker: { image, autoBuildImage: false },
    };
    runtime = await startSandboxRuntime({
      settings: { ...baseSettings, sandbox },
      cwd: process.cwd(),
      sessionId,
    });
    const containerName = runtime.status.containerName!;
    const workDir = await mkdtemp(join(process.cwd(), ".sandbox-e2e-abort-"));
    const pidFile = join(workDir, "pids");
    const containerPidFile = `${basename(workDir)}/pids`;
    const controller = new AbortController();

    try {
      const child = await createShellProcess(
        `trap '' TERM; sleep 300 & printf '%s %s\\n' "$$" "$!" > '${containerPidFile}'; wait`,
        {
          cwd: process.cwd(),
          sessionId,
          settings: { ...baseSettings, sandbox },
          signal: controller.signal,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const resultPromise = collectProcess(child);
      await waitFor(() => existsSync(pidFile), 10_000);
      const pids = (await readFile(pidFile, "utf8")).trim().split(/\s+/).map(Number);
      expect(pids).toHaveLength(2);
      expect(pids.every((pid) => dockerProcessRunning(containerName, pid))).toBe(true);

      controller.abort();
      const result = await withTimeout(resultPromise, 10_000, "aborted docker command did not close");
      expect(result.exitCode).not.toBe(0);
      await waitFor(
        () => pids.every((pid) => !dockerProcessRunning(containerName, pid)),
        5_000,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("stopping a reusable runtime removes commands but keeps the container", async () => {
    const sessionId = `e2e-reuse-stop-${Date.now()}`;
    const sandbox = {
      enabled: true,
      backend: "docker" as const,
      failIfUnavailable: true,
      network: { mode: "none" as const },
      docker: {
        image,
        autoBuildImage: false,
        reuseContainer: true,
        containerNamePrefix: `${reusablePrefix}-stop`,
      },
    };
    runtime = await startSandboxRuntime({
      settings: { ...baseSettings, sandbox },
      cwd: process.cwd(),
      sessionId,
    });
    const containerName = runtime.status.containerName!;
    ownedContainers.add(containerName);
    const workDir = await mkdtemp(join(process.cwd(), ".sandbox-e2e-stop-"));
    const pidFile = join(workDir, "pids");
    const containerPidFile = `${basename(workDir)}/pids`;

    try {
      const child = await createShellProcess(
        `trap '' TERM; sleep 300 & printf '%s %s\\n' "$$" "$!" > '${containerPidFile}'; wait`,
        {
          cwd: process.cwd(),
          sessionId,
          settings: { ...baseSettings, sandbox },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.on("error", () => {});
      await waitFor(() => existsSync(pidFile), 10_000);
      const pids = (await readFile(pidFile, "utf8")).trim().split(/\s+/).map(Number);

      await runtime.stop();
      runtime = undefined;
      expect(dockerContainerRunning(containerName)).toBe(true);
      await waitFor(
        () => pids.every((pid) => !dockerProcessRunning(containerName, pid)),
        5_000,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("blocks outbound network when Docker network mode is none", async () => {
    const sessionId = `e2e-docker-none-${Date.now()}`;
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
      sessionId,
    });

    const child = await createShellProcess(
      "node -e \"fetch('https://example.com').then(()=>process.exit(0)).catch(()=>process.exit(7))\"",
      {
        cwd: process.cwd(),
        sessionId,
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
      const sessionId = `e2e-docker-bridge-${Date.now()}`;
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
        sessionId,
      });

      const child = await createShellProcess(
        "node -e \"fetch('https://example.com').then(r=>{console.log(r.status); process.exit(r.status === 200 ? 0 : 1)}).catch(e=>{console.error(e); process.exit(1)})\"",
        {
          cwd: process.cwd(),
          sessionId,
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

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
