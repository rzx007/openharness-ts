import { describe, expect, it } from "vitest";

import { resolveEnvironmentOwner } from "./environment-owner.js";

describe("resolveEnvironmentOwner", () => {
  it("uses the normalized project workspace in reuse mode", () => {
    const session = record("project-root", "D:\\Repo", { projectId: "p1" });
    expect(resolveEnvironmentOwner(session, store([session]), { reuseContainer: true }))
      .toEqual({
        ownerId: "project:d:/repo",
        hostRoot: "D:\\Repo",
        rootSessionId: "project-root",
      });
  });

  it("lets a projectless fork inherit the root session owner", () => {
    const root = record("outside-root", "D:\\Documents\\OpenHarness\\x1");
    const fork = record("outside-fork", root.cwd, { parentId: root.id });
    expect(resolveEnvironmentOwner(fork, store([root, fork]), { reuseContainer: false }))
      .toEqual({
        ownerId: "session:outside-root",
        hostRoot: root.cwd,
        rootSessionId: root.id,
      });
  });

  it("gives an isolated child cwd its own workspace owner", () => {
    const root = record("root", "D:\\repo", { projectId: "p1" });
    const child = record("child", "D:\\repo-worktrees\\child", {
      projectId: "p1",
      parentId: root.id,
    });
    expect(resolveEnvironmentOwner(child, store([root, child]), { reuseContainer: true }))
      .toEqual({
        ownerId: "workspace:d:/repo-worktrees/child",
        hostRoot: child.cwd,
        rootSessionId: child.id,
      });
  });
});

function record(
  id: string,
  cwd: string,
  extra: { projectId?: string; parentId?: string } = {},
) {
  return { id, cwd, ...extra } as any;
}

function store(records: Array<{ id: string }>) {
  const byId = new Map(records.map((item) => [item.id, item]));
  return { getSession: (id: string) => byId.get(id) };
}
