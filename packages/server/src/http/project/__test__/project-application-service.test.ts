import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "@openharness/services";
import { describe, expect, it, vi } from "vitest";

import { ProjectApplicationError, ProjectApplicationService } from "../project-application-service.js";

describe("ProjectApplicationService.rebindProject", () => {
  it("closes warm agents for in-tree sessions before rewriting cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "oh-project-app-"));
    mkdirSync(join(root, "source"), { recursive: true });
    mkdirSync(join(root, "moved"), { recursive: true });
    const store = new SessionStore({ path: join(root, "store.db") });

    try {
      const project = store.inspectProject(join(root, "source"));
      const session = store.createSession({
        id: "s1",
        projectId: project.id,
        cwd: join(root, "source"),
        model: "m",
      });
      const close = vi.fn(async () => undefined);
      const publishSince = vi.fn();
      const service = new ProjectApplicationService({
        store,
        runEngine: { hasWork: () => false },
        agentPool: { close, hasActiveWorkForSession: () => false },
        liveChildren: { has: () => false },
        events: { checkpoint: () => 0, publishSince },
      });

      const rebound = await service.rebindProject(project.id, join(root, "moved"));
      expect(close).toHaveBeenCalledWith(session.id);
      expect(publishSince).toHaveBeenCalledWith(0);
      expect(rebound.path).toBe(join(root, "moved"));
      expect(store.getSession(session.id)?.cwd).toBe(join(root, "moved"));
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses rebind while a session run is active", async () => {
    const root = mkdtempSync(join(tmpdir(), "oh-project-busy-"));
    mkdirSync(join(root, "source"), { recursive: true });
    mkdirSync(join(root, "moved"), { recursive: true });
    const store = new SessionStore({ path: join(root, "store.db") });

    try {
      const project = store.inspectProject(join(root, "source"));
      store.createSession({
        id: "busy",
        projectId: project.id,
        cwd: join(root, "source"),
        model: "m",
      });
      const service = new ProjectApplicationService({
        store,
        runEngine: { hasWork: (sessionId) => sessionId === "busy" },
        agentPool: { close: vi.fn(async () => undefined), hasActiveWorkForSession: () => false },
        liveChildren: { has: () => false },
        events: { checkpoint: () => 0, publishSince: vi.fn() },
      });

      await expect(service.rebindProject(project.id, join(root, "moved"))).rejects.toBeInstanceOf(
        ProjectApplicationError,
      );
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
