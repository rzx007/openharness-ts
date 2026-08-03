import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SessionStore } from "@openharness/services";

import { StorePermissionBroker } from "./permission-broker.js";

function withBroker(
  test: (ctx: { broker: StorePermissionBroker; store: SessionStore; changes: number[] }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ohs-permission-broker-"));
  const store = new SessionStore({ path: join(dir, "store.db") });
  const changes: number[] = [];
  const broker = new StorePermissionBroker({ store, onChange: (seq) => changes.push(seq) });
  store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
  const input = store.admitPrompt({ id: "i1", sessionId: "s1", content: "edit" });
  store.createRun({ id: "r1", sessionId: "s1", inputId: input.id });
  return test({ broker, store, changes }).finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

describe("StorePermissionBroker", () => {
  it("persists an ask before blocking and resolves when a client replies", async () => {
    await withBroker(async ({ broker, store, changes }) => {
      const allowed = broker.ask({
        sessionId: "s1",
        runId: "r1",
        toolName: "Write",
        reason: "needs edit",
        input: { path: "README.md" },
      });

      const pending = store.listPermissionRequests({ status: "pending" });
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        sessionId: "s1",
        runId: "r1",
        toolName: "Write",
        status: "pending",
      });
      expect(changes.length).toBeGreaterThanOrEqual(1);

      const replied = broker.reply({
        requestId: pending[0]!.id,
        status: "approved",
        decision: "once",
        clientId: "web-1",
      });
      expect(replied).toMatchObject({ status: "approved", decision: "once", decidedByClientId: "web-1" });
      await expect(allowed).resolves.toBe(true);
      expect(store.listEvents().map((event) => event.type)).toContain("permission.replied");
    });
  });

  it("persists session-scoped approvals and reuses them for later matching asks", async () => {
    await withBroker(async ({ broker, store }) => {
      const first = broker.ask({ sessionId: "s1", runId: "r1", toolName: "Bash", input: { command: "pnpm test" } });
      const firstRequest = store.listPermissionRequests({ status: "pending" })[0]!;
      broker.reply({ requestId: firstRequest.id, status: "approved", decision: "session" });
      await expect(first).resolves.toBe(true);

      await expect(broker.ask({ sessionId: "s1", runId: "r1", toolName: "Bash" })).resolves.toBe(true);
      const bashRequests = store.listPermissionRequests({ sessionId: "s1", toolName: "Bash" });
      expect(bashRequests).toHaveLength(2);
      expect(bashRequests[1]).toMatchObject({
        status: "approved",
        decision: "session",
        payload: { reusedApprovalRequestId: firstRequest.id },
      });
    });
  });

  it("routes child asks to the parent session and reuses parent session approvals", async () => {
    await withBroker(async ({ broker, store }) => {
      store.createSession({ id: "child", parentId: "s1", cwd: process.cwd(), model: "m" });
      const childInput = store.admitPrompt({ id: "child-input", sessionId: "child", content: "edit" });
      store.createRun({ id: "child-run", sessionId: "child", inputId: childInput.id });

      const parentAsk = broker.ask({ sessionId: "s1", runId: "r1", toolName: "Write" });
      const parentRequest = store.listPermissionRequests({ sessionId: "s1", status: "pending" })[0]!;
      broker.reply({ requestId: parentRequest.id, status: "approved", decision: "session" });
      await expect(parentAsk).resolves.toBe(true);

      const childAsk = broker.ask({
        sessionId: "child",
        runId: "child-run",
        toolName: "Write",
        input: { path: "child.txt" },
      });
      await expect(childAsk).resolves.toBe(true);

      const childRequest = store.listPermissionRequests({ sessionId: "s1", toolName: "Write" }).at(-1);
      expect(childRequest).toMatchObject({
        sessionId: "s1",
        status: "approved",
        decision: "session",
        payload: {
          childSessionId: "child",
          childRunId: "child-run",
          reusedApprovalRequestId: parentRequest.id,
        },
      });
      expect(childRequest?.runId).toBeUndefined();
      expect(store.listPermissionRequests({ sessionId: "child" })).toHaveLength(0);
    });
  });

  it("expires a pending request when its run is interrupted", async () => {
    await withBroker(async ({ broker, store }) => {
      const controller = new AbortController();
      const allowed = broker.ask({
        sessionId: "s1",
        runId: "r1",
        toolName: "Write",
        signal: controller.signal,
      });
      const request = store.listPermissionRequests({ status: "pending" })[0]!;
      controller.abort();

      await expect(allowed).resolves.toBe(false);
      expect(store.getPermissionRequest(request.id)).toMatchObject({ status: "expired" });
    });
  });
});
