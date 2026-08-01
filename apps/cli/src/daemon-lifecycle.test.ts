import { describe, expect, it } from "vitest";

import type { DaemonRegistry } from "@openharness/server";

import { probeDaemonRegistry } from "./daemon-lifecycle.js";

function registry(overrides: Partial<DaemonRegistry> = {}): DaemonRegistry {
  return {
    url: "http://daemon.test",
    pid: 42,
    token: "token",
    storePath: "sessions.json",
    startedAt: 100,
    version: "0.1.0",
    ...overrides,
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("probeDaemonRegistry", () => {
  it("accepts a healthy daemon from the current build", async () => {
    const status = await probeDaemonRegistry(registry(), {
      pidAlive: () => true,
      fetch: async () => response({ ok: true, version: "0.1.0" }),
      expectedVersion: "0.1.0",
      minimumStartedAt: 100,
    });
    expect(status).toBe("ready");
  });

  it("marks a daemon started before the current CLI build as stale", async () => {
    const status = await probeDaemonRegistry(registry({ startedAt: 99 }), {
      pidAlive: () => true,
      fetch: async () => response({ ok: true, version: "0.1.0" }),
      expectedVersion: "0.1.0",
      minimumStartedAt: 100,
    });
    expect(status).toBe("stale");
  });

  it("marks a daemon from another release as stale", async () => {
    const status = await probeDaemonRegistry(registry({ version: "0.0.9" }), {
      pidAlive: () => true,
      fetch: async () => response({ ok: true, version: "0.0.9" }),
      expectedVersion: "0.1.0",
    });
    expect(status).toBe("stale");
  });

  it("does not treat an unrelated reused pid as a stale OpenHarness daemon", async () => {
    const status = await probeDaemonRegistry(registry(), {
      pidAlive: () => true,
      fetch: async () => response({ error: "Unauthorized" }, 401),
    });
    expect(status).toBe("unreachable");
  });
});
