import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DOCKER_CONFIG_HASH_LABEL,
  DOCKER_CREATED_BY_GENERATION_LABEL,
  DOCKER_CREATED_BY_OWNER_LABEL,
  DOCKER_ENVIRONMENT_ID_LABEL,
  DOCKER_INSTALLATION_LABEL,
  DOCKER_MANAGED_LABEL,
  DOCKER_REUSABLE_LABEL,
  DOCKER_WORKSPACE_LABEL,
  DOCKER_WORKSPACE_OWNER_LABEL,
  reconcileDockerOrphans,
} from "../src/index.js";

const image = process.env.OPENHARNESS_E2E_DOCKER_IMAGE ?? "openharness-sandbox:latest";
const runDocker = dockerAvailable();
const maybeDescribe = runDocker ? describe : describe.skip;
const nonce = randomUUID().replaceAll("-", "").slice(0, 12);
const prefix = `ohs-orphan-${nonce}`;
const installationId = `install-${nonce}`;
const oldDaemon = { ownerId: `daemon-old-${nonce}`, generation: 1 };
const currentDaemon = { ownerId: `daemon-current-${nonce}`, generation: 1 };
const containerNames = {
  temporary: `${prefix}-temporary`,
  reusable: `${prefix}-reusable`,
  foreign: `${prefix}-foreign`,
};

beforeAll(() => {
  if (!runDocker) {
    console.warn("[sandbox:e2e:orphan] skipped: Docker CLI or daemon is unavailable");
  }
});

afterAll(() => {
  for (const name of Object.values(containerNames)) {
    docker(["rm", "-f", name], { allowFailure: true });
  }
});

maybeDescribe("Docker orphan reconciliation e2e", () => {
  it("removes only owned temporary containers and stale reusable executions", async () => {
    createManagedContainer(containerNames.temporary, {
      installationId,
      reusable: false,
      daemon: oldDaemon,
    });
    createManagedContainer(containerNames.reusable, {
      installationId,
      reusable: true,
      daemon: oldDaemon,
    });
    createManagedContainer(containerNames.foreign, {
      installationId: `foreign-${nonce}`,
      reusable: false,
      daemon: oldDaemon,
    });
    startOwnedExecution(containerNames.reusable, installationId, oldDaemon, "old-execution");
    startOwnedExecution(
      containerNames.reusable,
      installationId,
      currentDaemon,
      "current-execution",
    );
    await waitFor(async () => {
      const ids = readOwnedExecutionIds(containerNames.reusable, installationId);
      return ids.has("old-execution") && ids.has("current-execution");
    });

    const report = await reconcileDockerOrphans({
      installationId,
      daemon: currentDaemon,
    });

    await waitFor(async () => !containerExists(containerNames.temporary));
    expect(containerExists(containerNames.reusable)).toBe(true);
    expect(containerExists(containerNames.foreign)).toBe(true);
    await waitFor(async () => {
      const ids = readOwnedExecutionIds(containerNames.reusable, installationId);
      return !ids.has("old-execution") && ids.has("current-execution");
    });
    expect(report.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "remove_container" }),
      expect.objectContaining({ kind: "kill_execution" }),
    ]));
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ownership_unverified" }),
    ]));
  }, 90_000);
});

function createManagedContainer(
  name: string,
  input: {
    installationId: string;
    reusable: boolean;
    daemon: { ownerId: string; generation: number };
  },
): void {
  docker([
    "run",
    "-d",
    "--name",
    name,
    "--label",
    `${DOCKER_MANAGED_LABEL}=true`,
    "--label",
    `${DOCKER_INSTALLATION_LABEL}=${input.installationId}`,
    "--label",
    `${DOCKER_WORKSPACE_OWNER_LABEL}=workspace:${name}`,
    "--label",
    `${DOCKER_WORKSPACE_LABEL}=/tmp/${name}`,
    "--label",
    `${DOCKER_CONFIG_HASH_LABEL}=config-${nonce}`,
    "--label",
    `${DOCKER_REUSABLE_LABEL}=${input.reusable}`,
    "--label",
    `${DOCKER_CREATED_BY_OWNER_LABEL}=${input.daemon.ownerId}`,
    "--label",
    `${DOCKER_CREATED_BY_GENERATION_LABEL}=${input.daemon.generation}`,
    "--label",
    `${DOCKER_ENVIRONMENT_ID_LABEL}=environment-${name}`,
    image,
    "tail",
    "-f",
    "/dev/null",
  ]);
}

function startOwnedExecution(
  containerName: string,
  installation: string,
  daemon: { ownerId: string; generation: number },
  executionId: string,
): void {
  docker([
    "exec",
    "-d",
    "-e",
    `OPENHARNESS_INSTALLATION_ID=${installation}`,
    "-e",
    `OPENHARNESS_DAEMON_OWNER_ID=${daemon.ownerId}`,
    "-e",
    `OPENHARNESS_DAEMON_GENERATION=${daemon.generation}`,
    "-e",
    `OPENHARNESS_ENVIRONMENT_ID=environment-${containerName}`,
    "-e",
    "OPENHARNESS_EXECUTION_KIND=background",
    "-e",
    `OPENHARNESS_EXECUTION_ID=${executionId}`,
    containerName,
    "/bin/sh",
    "-c",
    "sleep 120",
  ]);
}

function readOwnedExecutionIds(
  containerName: string,
  installation: string,
): Set<string> {
  const script = String.raw`
for environment_file in /proc/[0-9]*/environ; do
  [ -r "$environment_file" ] || continue
  values=$(tr '\0' '\n' < "$environment_file" 2>/dev/null)
  found_installation=$(printf '%s\n' "$values" | grep -m1 '^OPENHARNESS_INSTALLATION_ID=' | cut -d= -f2-)
  [ "$found_installation" = "$1" ] || continue
  printf '%s\n' "$values" | grep -m1 '^OPENHARNESS_EXECUTION_ID=' | cut -d= -f2-
done
`.trim();
  const output = docker([
    "exec",
    containerName,
    "/bin/sh",
    "-c",
    script,
    "openharness-read-owned-executions",
    installation,
  ]).stdout;
  return new Set(output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean));
}

function containerExists(name: string): boolean {
  return docker(["container", "inspect", name], { allowFailure: true }).status === 0;
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (!await predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Docker orphan E2E timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function docker(
  args: string[],
  options: { allowFailure?: boolean } = {},
): ReturnType<typeof spawnSync> {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`docker ${args.join(" ")} failed: ${result.stderr || result.error?.message}`);
  }
  return result;
}

function dockerAvailable(): boolean {
  const result = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    stdio: "ignore",
    windowsHide: true,
    timeout: 5_000,
  });
  return result.status === 0;
}
