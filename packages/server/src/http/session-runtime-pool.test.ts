import { describe, expect, it, vi } from "vitest";

import { SessionRuntimePool } from "./session-runtime-pool.js";

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

function createContext(createRuntime = vi.fn(async () => ({
  runPrompt: vi.fn(),
  close: vi.fn(async () => {}),
}))) {
  return {
    store: {
      getSession: vi.fn(() => session),
      listMessages: vi.fn(() => []),
      listMessageParts: vi.fn(() => []),
      listSessions: vi.fn(() => [session]),
    },
    runtimeFactory: { createRuntime },
  };
}

describe("SessionRuntimePool", () => {
  it("deduplicates concurrent runtime creation and closes the cached runtime", async () => {
    const close = vi.fn(async () => {});
    const createRuntime = vi.fn(async () => ({ runPrompt: vi.fn(), close }));
    const context = createContext(createRuntime);
    const pool = new SessionRuntimePool(context as any);

    const [first, second] = await Promise.all([
      pool.acquire(session as any, [], []),
      pool.acquire(session as any, [], []),
    ]);

    expect(first).toBe(second);
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(pool.size).toBe(1);

    await pool.close(session.id);

    expect(close).toHaveBeenCalledOnce();
    expect(pool.size).toBe(0);
  });

  it("evicts a runtime when creation fails", async () => {
    const createRuntime = vi.fn()
      .mockRejectedValueOnce(new Error("startup failed"))
      .mockResolvedValueOnce({ runPrompt: vi.fn(), close: vi.fn() });
    const pool = new SessionRuntimePool(createContext(createRuntime) as any);

    await pool.warm(session.id);
    expect(pool.size).toBe(0);

    await pool.acquire(session as any, [], []);
    expect(createRuntime).toHaveBeenCalledTimes(2);
    expect(pool.size).toBe(1);
  });
});
