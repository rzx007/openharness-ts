import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Settings } from "@openharness/core";
import { SessionStore } from "@openharness/services";
import { afterEach, describe, expect, it } from "vitest";

import { DaemonCronService } from "../daemon-cron-service.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function settings(): Settings {
  return {
    model: "test",
    apiFormat: "openai",
    maxTurns: 1,
    permission: { mode: "default" },
    sandbox: { enabled: false },
  };
}

function createService(): { service: DaemonCronService; store: SessionStore } {
  const dir = mkdtempSync(join(tmpdir(), "ohs-daemon-cron-"));
  const store = new SessionStore({ path: join(dir, "store.db") });
  const service = new DaemonCronService({ store, getSettingsForCwd: async () => settings() });
  cleanups.push(async () => {
    await service.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { service, store };
}

describe("DaemonCronService", () => {
  it("keeps scheduler state and SQLite state in sync", () => {
    const { service, store } = createService();
    const saved = service.saveJob({
      name: "check",
      expression: "* * * * *",
      command: "echo ok",
      cwd: process.cwd(),
    });

    expect(service.listJobs()).toMatchObject([{ id: saved.id, enabled: true }]);
    expect(service.setEnabled("check", false).enabled).toBe(false);
    expect(store.getCronJobByName("check")?.nextRunAt).toBeUndefined();
    expect(service.removeJob("check")).toBe(true);
    expect(service.listJobs()).toEqual([]);
  });

  it("runs a command through the daemon and saves its result", async () => {
    const { service } = createService();
    const job = service.saveJob({
      name: "manual",
      expression: "0 0 * * *",
      command: "echo daemon-cron-ok",
      cwd: process.cwd(),
      enabled: false,
    });

    expect(job.nextRunAt).toBeUndefined();

    const run = await service.trigger("manual");

    expect(run.status).toBe("succeeded");
    expect(run.output).toContain("daemon-cron-ok");
    expect(service.listRuns({ name: "manual" })).toEqual([run]);
  });

  it("keeps run history queryable after a job is removed", async () => {
    const { service } = createService();
    service.saveJob({
      name: "removed",
      expression: "0 0 * * *",
      command: "echo retained",
      cwd: process.cwd(),
      enabled: false,
    });
    const run = await service.trigger("removed");

    service.removeJob("removed");

    expect(service.listRuns({ name: "removed" })).toEqual([run]);
  });
});
