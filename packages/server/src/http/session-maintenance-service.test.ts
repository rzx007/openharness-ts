import { describe, expect, it, vi } from "vitest";

import { SessionMaintenanceService } from "./session-maintenance-service.js";

const session = {
  id: "s1",
  cwd: "/repo",
  title: "Session",
  model: "gpt-test",
  status: "idle",
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
};

function createMaintenance(runtime: Record<string, any>) {
  const replaced = { messages: [{ id: "persisted-message" }], parts: [{ id: "persisted-part" }] };
  const store = {
    getSession: vi.fn(() => session),
    listMessages: vi.fn(() => []),
    listMessageParts: vi.fn(() => []),
    replaceTranscript: vi.fn(() => replaced),
  };
  const runEngine = {
    hasWork: vi.fn(() => false),
    hasActiveRunsForCwd: vi.fn(() => false),
  };
  const runtimePool = {
    configured: true,
    warm: vi.fn(async () => {}),
    get: vi.fn(async () => runtime),
    close: vi.fn(async () => {}),
    closeForCwd: vi.fn(async () => {}),
  };
  const broadcastSince = vi.fn();
  const maintenance = new SessionMaintenanceService({
    store: store as any,
    runEngine: runEngine as any,
    runtimePool: runtimePool as any,
    events: { checkpoint: () => 7, publishSince: broadcastSince },
  });
  return { maintenance, store, runEngine, runtimePool, broadcastSince, replaced };
}

describe("SessionMaintenanceService", () => {
  it("persists the compacted transcript and broadcasts the replacement", async () => {
    const compact = vi.fn(async () => ({ messageCount: 2, transcript: [] }));
    const { maintenance, store, broadcastSince, replaced } = createMaintenance({ compact });

    const result = await maintenance.compact("s1");

    expect(compact).toHaveBeenCalledOnce();
    expect(store.replaceTranscript).toHaveBeenCalledWith({ sessionId: "s1", messages: [] });
    expect(result).toEqual({ messageCount: 2, ...replaced });
    expect(broadcastSince).toHaveBeenCalledWith(7);
  });

  it("replaces a rewound transcript and closes its stale runtime", async () => {
    const { maintenance, store, runtimePool, broadcastSince } = createMaintenance({});
    store.listMessages.mockReturnValue([{
      id: "message-1",
      seq: 1,
      sessionId: "s1",
      role: "user",
      metadata: {},
    }] as any);
    store.listMessageParts.mockReturnValue([{
      id: "part-1",
      seq: 1,
      sessionId: "s1",
      messageId: "message-1",
      type: "text",
      status: "completed",
      text: "hello",
      metadata: {},
    }] as any);

    const result = await maintenance.rewind("s1", 1);

    expect(result).toMatchObject({ turns: 1, removed: 1 });
    expect(store.replaceTranscript).toHaveBeenCalledWith({ sessionId: "s1", messages: [] });
    expect(runtimePool.close).toHaveBeenCalledWith("s1");
    expect(broadcastSince).toHaveBeenCalledWith(7);
  });

  it("extracts memories and closes every runtime for the cwd", async () => {
    const remembered = { skipped: false, writtenIds: ["memory-1"], titles: ["Fact"] };
    const remember = vi.fn(async () => remembered);
    const { maintenance, runtimePool } = createMaintenance({ remember });

    await expect(maintenance.remember("s1")).resolves.toBe(remembered);
    expect(runtimePool.closeForCwd).toHaveBeenCalledWith("/repo");
  });
});
