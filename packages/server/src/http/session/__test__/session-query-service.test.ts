import { describe, expect, it, vi } from "vitest";

import { SessionQueryService } from "../session-query-service.js";

describe("SessionQueryService", () => {
  it("filters child sessions and resolves list titles", () => {
    const root = { id: "root", title: "Stored root" };
    const child = { id: "child", parentId: "root", title: "Stored child" };
    const store = {
      listSessions: vi.fn(() => [root, child]),
      resolveSessionListTitle: vi.fn((sessionId: string) => `Resolved ${sessionId}`),
      getSession: vi.fn(),
      getSessionState: vi.fn(),
      listMessages: vi.fn(),
      listMessageParts: vi.fn(),
    };
    const queries = new SessionQueryService(store as any);

    const sessions = queries.listSessions({ cwd: "/repo", includeChildren: false, limit: 20 });

    expect(store.listSessions).toHaveBeenCalledWith({
      cwd: "/repo",
      includeArchived: undefined,
      limit: 20,
    });
    expect(sessions).toEqual([{ ...root, title: "Resolved root" }]);
  });

  it("keeps child sessions when explicitly requested", () => {
    const sessions = [
      { id: "root", title: "Root" },
      { id: "child", parentId: "root", title: "Child" },
    ];
    const queries = new SessionQueryService({
      listSessions: () => sessions,
      resolveSessionListTitle: (sessionId: string) => sessionId,
    } as any);

    expect(queries.listSessions({ includeChildren: true })).toHaveLength(2);
  });
});
