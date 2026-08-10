import { describe, expect, it, vi } from "vitest";

import { AgentPool } from "./agent-pool.js";

const session = {
  id: "s1",
  cwd: "/repo",
  title: "Session",
  model: "gpt-test",
  status: "idle",
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
} as const;

function createAgent(close = vi.fn(async () => {})) {
  return {
    loadHistory: vi.fn(),
    close,
  } as any;
}

function createContext(factory = vi.fn(async () => createAgent())) {
  return {
    store: {
      getSession: vi.fn(() => session),
      listMessages: vi.fn(() => []),
      listMessageParts: vi.fn(() => []),
      listSessions: vi.fn(() => [session]),
    },
    createAgent: factory,
  };
}

describe("AgentPool", () => {
  it("does not create a second agent for a framework-owned live child session", async () => {
    const context = createContext();
    const pool = new AgentPool({
      ...context,
      isSessionExternallyOwned: (sessionId) => sessionId === "s1",
    } as any);

    await pool.warm("s1");
    expect(context.createAgent).not.toHaveBeenCalled();
    await expect(pool.acquire(session as any, [], [])).rejects.toThrow("owned by a live child agent");
  });

  it("deduplicates concurrent agent creation and closes the cached agent", async () => {
    const close = vi.fn(async () => {});
    const factory = vi.fn(async () => createAgent(close));
    const pool = new AgentPool(createContext(factory) as any);

    const [first, second] = await Promise.all([
      pool.acquire(session as any, [], []),
      pool.acquire(session as any, [], []),
    ]);

    expect(first).toBe(second);
    expect(factory).toHaveBeenCalledOnce();
    expect(pool.size).toBe(1);

    await pool.close(session.id);

    expect(close).toHaveBeenCalledOnce();
    expect(pool.size).toBe(0);
  });

  it("evicts an agent when creation fails", async () => {
    const factory = vi.fn()
      .mockRejectedValueOnce(new Error("startup failed"))
      .mockResolvedValueOnce(createAgent());
    const pool = new AgentPool(createContext(factory) as any);

    await pool.warm(session.id);
    expect(pool.size).toBe(0);

    await pool.acquire(session as any, [], []);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(pool.size).toBe(1);
  });
});
