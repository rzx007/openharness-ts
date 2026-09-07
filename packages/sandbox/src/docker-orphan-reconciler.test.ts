import { describe, expect, it } from "vitest";

import {
  planDockerOrphanReconciliation,
  reconcileDockerOrphans,
  type DockerManagedResourceInventory,
} from "./docker-orphan-reconciler.js";

const CURRENT = {
  installationId: "install-1",
  daemon: { ownerId: "daemon-new", generation: 1 },
};

describe("planDockerOrphanReconciliation", () => {
  it("removes old temporary containers and only kills stale execs in reusable containers", () => {
    const inventory: DockerManagedResourceInventory = {
      containers: [
        container({
          id: "temp-id",
          name: "temp",
          reusable: false,
          createdByOwnerId: "daemon-old",
          createdByGeneration: 1,
        }),
        container({
          id: "reuse-id",
          name: "reuse",
          reusable: true,
          createdByOwnerId: "daemon-old",
          createdByGeneration: 1,
          executions: [
            execution(42, "daemon-old", 1),
            execution(43, "daemon-new", 1),
          ],
        }),
      ],
      diagnostics: [],
    };

    expect(planDockerOrphanReconciliation(inventory, CURRENT)).toEqual({
      actions: [
        {
          kind: "kill_execution",
          containerId: "reuse-id",
          pid: 42,
          reason: "stale_daemon_execution",
        },
        {
          kind: "remove_container",
          containerId: "temp-id",
          reason: "orphan_temporary_environment",
        },
      ],
      diagnostics: [],
    });
  });

  it("does not act on resources whose installation or owner cannot be verified", () => {
    const inventory: DockerManagedResourceInventory = {
      containers: [
        container({ id: "other", installationId: "install-2" }),
        container({ id: "missing-installation", installationId: "" }),
        container({
          id: "missing-owner",
          reusable: false,
          createdByOwnerId: "",
        }),
      ],
      diagnostics: [],
    };

    const plan = planDockerOrphanReconciliation(inventory, CURRENT);

    expect(plan.actions).toEqual([]);
    expect(plan.diagnostics).toEqual([
      expect.objectContaining({ containerId: "other", code: "ownership_unverified" }),
      expect.objectContaining({ containerId: "missing-installation", code: "ownership_unverified" }),
      expect.objectContaining({ containerId: "missing-owner", code: "ownership_unverified" }),
    ]);
  });
});

describe("reconcileDockerOrphans", () => {
  it("reports Docker inventory failure instead of treating it as an empty inventory", async () => {
    const result = await reconcileDockerOrphans({
      ...CURRENT,
      runDocker: async () => ({
        code: 1,
        stdout: "",
        stderr: "Docker daemon unavailable",
      }),
    });

    expect(result.actions).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "docker_inventory_failed",
        message: expect.stringContaining("Docker daemon unavailable"),
      }),
    ]);
  });
});

function container(overrides: Partial<DockerManagedResourceInventory["containers"][number]> = {}) {
  return {
    id: "container-1",
    name: "container",
    running: true,
    installationId: "install-1",
    workspaceOwnerId: "project:d:/repo",
    reusable: true,
    createdByOwnerId: "daemon-old",
    createdByGeneration: 1,
    executions: [],
    ...overrides,
  };
}

function execution(pid: number, daemonOwnerId: string, daemonGeneration: number) {
  return {
    pid,
    daemonOwnerId,
    daemonGeneration,
    environmentId: "environment-1",
    executionKind: "background",
    executionId: `task-${pid}`,
  };
}
