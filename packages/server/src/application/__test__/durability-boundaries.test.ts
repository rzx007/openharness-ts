import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createWorkflowPlan,
  createWorkflowRunSnapshot,
  type WorkflowSpec,
} from "@openharness/coordinator";
import {
  ApplicationOwnerConflictError,
  SessionStore,
} from "@openharness/services";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApplicationBackup, restoreApplicationBackup } from "../backup/application-backup.js";
import { SessionWorkflowRunRepository } from "../workflow/session-workflow-run-repository.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("durable application long-running boundaries", () => {
  it("rejects a second live owner and fences the old generation after stale takeover", () => {
    const dir = temporaryDirectory();
    const path = join(dir, "sessions.db");
    const first = new SessionStore({ path });
    const second = new SessionStore({ path });
    const firstLease = first.acquireApplicationOwner({ ownerId: "first", pid: 1, staleAfterMs: 100, now: 1_000 });
    first.createSession({ id: "owned-session", cwd: dir, model: "test" });

    expect(() => second.acquireApplicationOwner({
      ownerId: "second",
      pid: 2,
      staleAfterMs: 100,
      now: 1_050,
    })).toThrow(ApplicationOwnerConflictError);

    const secondLease = second.acquireApplicationOwner({
      ownerId: "second",
      pid: 2,
      staleAfterMs: 100,
      now: 1_101,
    });
    expect(secondLease.generation).toBe(firstLease.generation + 1);
    expect(() => first.createSession({ cwd: dir, model: "test" })).toThrow(ApplicationOwnerConflictError);
    expect(() => first.upsertExternalConversation({
      connector: "test",
      accountId: "account",
      chatId: "chat",
      sessionId: "owned-session",
    })).toThrow(ApplicationOwnerConflictError);
    second.releaseApplicationOwner(secondLease);
    first.close();
    second.close();
  });

  it("stores Workflow facts directly in SQLite", () => {
    const dir = temporaryDirectory();
    const store = new SessionStore({ path: join(dir, "sessions.db") });
    store.createSession({ id: "session-1", cwd: dir, model: "test" });
    const workflows = new SessionWorkflowRunRepository(store);
    workflows.save(workflowSnapshot("workflow-1", "session-1", "completed"));
    expect(workflows.load("workflow-1")).toMatchObject({
      ownerSession: "session-1",
      status: "completed",
    });
    store.close();
  });

  it("backs up the database and files, verifies checksums, and restores into an empty location", async () => {
    const dir = temporaryDirectory();
    const store = new SessionStore({ path: join(dir, "source", "sessions.db") });
    store.createSession({ id: "session-1", cwd: dir, model: "test" });
    store.acquireApplicationOwner({ ownerId: "source", pid: 1, staleAfterMs: 10_000 });
    const memory = join(dir, "memory");
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, "fact.md"), "durable fact", "utf-8");
    const backup = join(dir, "backup");
    await createApplicationBackup({ store, destination: backup, sources: { memory } });

    const checksumsPath = join(backup, "checksums.json");
    const checksums = JSON.parse(readFileSync(checksumsPath, "utf-8")) as Record<string, string>;
    writeFileSync(checksumsPath, JSON.stringify(Object.fromEntries(Object.entries(checksums).reverse())));

    const occupiedMemory = join(dir, "occupied-memory");
    mkdirSync(occupiedMemory);
    writeFileSync(join(occupiedMemory, "keep.txt"), "keep");
    const blockedStorePath = join(dir, "blocked", "sessions.db");
    expect(() => restoreApplicationBackup({
      source: backup,
      storePath: blockedStorePath,
      destinations: { memory: occupiedMemory },
    })).toThrow("not empty");
    expect(existsSync(blockedStorePath)).toBe(false);

    const restoredPath = join(dir, "restored", "sessions.db");
    const restoredMemory = join(dir, "restored-memory");
    const manifest = restoreApplicationBackup({
      source: backup,
      storePath: restoredPath,
      destinations: { memory: restoredMemory },
    });
    expect(manifest.recovery.reviveLiveProcesses).toBe(false);
    const restored = new SessionStore({ path: restoredPath });
    expect(restored.getSession("session-1")).toBeDefined();
    expect(restored.acquireApplicationOwner({ ownerId: "restored", pid: 2, staleAfterMs: 10_000 })).toMatchObject({ generation: 1 });
    restored.close();
    store.close();
  });

  it("retention keeps active Workflow facts and records an audit", () => {
    const dir = temporaryDirectory();
    const store = new SessionStore({ path: join(dir, "sessions.db") });
    store.createSession({ id: "session-1", cwd: dir, model: "test" });
    const workflows = new SessionWorkflowRunRepository(store);
    const running = workflowSnapshot("running-1", "session-1", "running");
    running.updatedAt = 1;
    workflows.save(running);
    const result = store.applyRetention({
      durableEventMaxAgeMs: 1,
      workflowEventMaxAgeMs: 1,
      workflowRunMaxAgeMs: 1,
      runAttemptMaxAgeMs: 1,
      projectionSettlementMaxAgeMs: 1,
      completedJobVisibleForMs: 1,
      terminalOutputMaxBytes: 1,
    }, 10_000);
    expect(result.workflows).toBe(0);
    expect(workflows.load("running-1")).toBeDefined();
    expect(store.listRetentionAudits()).toHaveLength(1);
    store.close();
  });

  it("wakes Workflow waiters from repository changes without Store polling", async () => {
    const dir = temporaryDirectory();
    const store = new SessionStore({ path: join(dir, "sessions.db") });
    store.createSession({ id: "session-1", cwd: dir, model: "test" });
    const workflows = new SessionWorkflowRunRepository(store);
    const running = workflowSnapshot("wait-1", "session-1", "running");
    workflows.save(running);
    const waiting = workflows.waitForChange("wait-1", running.updatedAt, { timeoutMs: 1_000 });
    workflows.save(workflowSnapshot("wait-1", "session-1", "completed"));
    await expect(waiting).resolves.toMatchObject({ status: "completed" });
    store.close();
  });

  it("does not miss a Workflow change between the first read and listener registration", async () => {
    const dir = temporaryDirectory();
    const store = new SessionStore({ path: join(dir, "sessions.db") });
    store.createSession({ id: "session-1", cwd: dir, model: "test" });
    const workflows = new SessionWorkflowRunRepository(store);
    const running = workflowSnapshot("race-1", "session-1", "running");
    running.updatedAt = 100;
    workflows.save(running);
    const originalLoad = workflows.load.bind(workflows);
    let reads = 0;
    vi.spyOn(workflows, "load").mockImplementation((runId) => {
      reads += 1;
      if (reads === 2) {
        const completed = workflowSnapshot("race-1", "session-1", "completed");
        completed.updatedAt = 101;
        workflows.save(completed);
      }
      return originalLoad(runId);
    });

    await expect(workflows.waitForChange("race-1", 100, { timeoutMs: 1_000 }))
      .resolves.toMatchObject({ status: "completed", updatedAt: 101 });
    store.close();
  });

  it("rejects a duplicate Workflow claim in the same Application", () => {
    const dir = temporaryDirectory();
    const store = new SessionStore({ path: join(dir, "sessions.db") });
    store.createSession({ id: "session-1", cwd: dir, model: "test" });
    const workflows = new SessionWorkflowRunRepository(store);
    workflows.save(workflowSnapshot("claimed-1", "session-1", "running"));
    workflows.claim("claimed-1");
    expect(() => workflows.claim("claimed-1")).toThrow("already claimed");
    workflows.finish("claimed-1", "failed");
    store.close();
  });
});

function workflowSnapshot(
  runId: string,
  ownerSession: string,
  status: "running" | "completed" | "failed",
) {
  const spec: WorkflowSpec = { mode: "sequential", tasks: [{ id: "one" }] };
  return createWorkflowRunSnapshot({
    runId,
    ownerSession,
    status,
    summary: runId,
    spec,
    plan: createWorkflowPlan(spec),
    results: new Map(),
    running: status === "running" ? new Set(["one"]) : new Set(),
    createdAt: Date.now(),
  });
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openharness-durability-"));
  temporaryDirectories.push(directory);
  return directory;
}
