import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  createDurableEventRegistry,
  defaultDurableEventRegistry,
  DurableEventRegistryError,
  type DurableEventDefinition,
} from "../event-registry.js";
import { SessionStore } from "../store.js";

const upgradedFixture: DurableEventDefinition = {
  type: "fixture.title.changed",
  currentVersion: 2,
  scope: "session",
  validate(payload) {
    if (typeof payload.title !== "string") throw new Error("title must be a string");
  },
  upgrades: {
    1: (payload) => ({ title: payload.name }),
  },
};

describe("DurableEventRegistry", () => {
  it("rejects unregistered event types instead of accepting typos", () => {
    expect(() => defaultDurableEventRegistry.prepareWrite(
      "session.mesage.created",
      { message: {} },
      "s1",
    )).toThrowError(expect.objectContaining<Partial<DurableEventRegistryError>>({
      code: "unknown_type",
      eventType: "session.mesage.created",
    }));
  });

  it("rejects missing fields, wrong field types, and invalid scope", () => {
    expect(() => defaultDurableEventRegistry.prepareWrite(
      "session.run.error",
      { runId: "r1" },
      "s1",
    )).toThrow("error must be a string");
    expect(() => defaultDurableEventRegistry.prepareWrite(
      "session.run.error",
      { runId: 42, error: "failed" },
      "s1",
    )).toThrow("runId must be a string");
    expect(() => defaultDurableEventRegistry.prepareWrite(
      "session.run.error",
      { runId: "r1", error: "failed" },
    )).toThrow("requires a sessionId");
  });

  it("upgrades a v1 fixture to v2 and rejects unknown higher versions", () => {
    const registry = createDurableEventRegistry([upgradedFixture]);
    expect(registry.prepareRead(
      upgradedFixture.type,
      1,
      { name: "New title" },
      "s1",
    )).toEqual({
      type: upgradedFixture.type,
      schemaVersion: 2,
      payload: { title: "New title" },
    });
    expect(() => registry.prepareRead(
      upgradedFixture.type,
      3,
      { title: "Future title" },
      "s1",
    )).toThrowError(expect.objectContaining<Partial<DurableEventRegistryError>>({
      code: "unsupported_version",
      schemaVersion: 3,
    }));
  });

  it("rejects unregistered event names at both read and write boundaries", () => {
    expect(() => defaultDurableEventRegistry.prepareRead(
      "provider.rate_limited",
      1,
      { frameworkEventId: "framework-1", retryAfterMs: 1_000 },
      "s1",
    )).toThrow("Unregistered durable event type");
    expect(() => defaultDurableEventRegistry.prepareWrite(
      "provider.rate_limited",
      { frameworkEventId: "framework-1", retryAfterMs: 1_000 },
      "s1",
    )).toThrow("Unregistered durable event type");
  });

  it("upgrades at the store read boundary without rewriting the original row", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohs-event-registry-"));
    const path = join(dir, "store.db");
    const registry = createDurableEventRegistry([upgradedFixture]);
    try {
      const initial = new SessionStore({ path, eventRegistry: registry });
      initial.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      initial.close();

      const database = new Database(path);
      database.prepare(`
        INSERT INTO session_event
          (id, seq, type, session_id, payload_json, created_at, schema_version)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run("fixture-v1", 2, upgradedFixture.type, "s1", '{"name":"Read-time upgrade"}', 100, 1);
      database.close();

      const reloaded = new SessionStore({ path, eventRegistry: registry });
      expect(reloaded.listEvents().find((event) => event.id === "fixture-v1")).toMatchObject({
        schemaVersion: 2,
        payload: { title: "Read-time upgrade" },
      });
      reloaded.close();

      const unchanged = new Database(path, { readonly: true });
      expect(unchanged.prepare(
        "SELECT schema_version, payload_json FROM session_event WHERE id = ?",
      ).get("fixture-v1")).toEqual({
        schema_version: 1,
        payload_json: '{"name":"Read-time upgrade"}',
      });
      unchanged.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("makes the store enforce the registry before allocating a cursor", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohs-event-registry-write-"));
    const path = join(dir, "store.db");
    try {
      const store = new SessionStore({ path });
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      const cursor = store.latestEventSeq();
      expect(() => store.appendEvent({
        type: "session.run.error",
        sessionId: "s1",
        payload: { runId: "r1", error: 42 },
      })).toThrow("error must be a string");
      expect(store.latestEventSeq()).toBe(cursor);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
