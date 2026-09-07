import { describe, expect, it, vi } from "vitest";

import { createSessionEnvironmentAcquirer } from "./session-execution-environment.js";

describe("createSessionEnvironmentAcquirer", () => {
  it("uses one project owner and Agent consumer for desktop-managed acquisition", async () => {
    const acquire = vi.fn(async (request) => request);
    const session = { id: "s1", cwd: "D:\\repo", projectId: "p1" } as any;
    const acquirer = createSessionEnvironmentAcquirer({
      manager: { acquire } as any,
      store: { getSession: () => session },
      daemonIdentity: {
        installationId: "install-1",
        daemonOwnerId: "daemon-1",
        daemonGeneration: 7,
      },
    });

    const result = await acquirer(session, {
      model: "test",
      apiFormat: "openai",
      maxTurns: 1,
      permission: { mode: "default" },
      sandbox: {
        enabled: true,
        backend: "docker",
        failIfUnavailable: true,
        docker: { reuseContainer: true },
      },
    });

    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: "project:d:/repo",
      configHash: expect.any(String),
      daemonIdentity: {
        installationId: "install-1",
        daemonOwnerId: "daemon-1",
        daemonGeneration: 7,
      },
      consumer: { kind: "agent", id: "s1" },
      create: expect.any(Function),
    }));
    expect(result).toMatchObject({ ownerId: "project:d:/repo" });
  });
});
