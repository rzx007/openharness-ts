import { describe, expect, it } from "vitest";

import { createWorkspaceBinding } from "./types.js";

describe("createWorkspaceBinding", () => {
  it("keeps host and execution roots separate for Docker", () => {
    expect(
      createWorkspaceBinding({
        kind: "docker",
        hostRoot: "D:\\code\\ohs",
        executionRoot: "/workspace",
      }),
    ).toEqual({
      kind: "docker",
      hostRoot: "D:\\code\\ohs",
      executionRoot: "/workspace",
    });
  });

  it("rejects a non-POSIX Docker execution root", () => {
    expect(() =>
      createWorkspaceBinding({
        kind: "docker",
        hostRoot: "D:\\code\\ohs",
        executionRoot: "D:\\code\\ohs",
      }),
    ).toThrow("Docker execution root must be an absolute POSIX path");
  });

  it("requires local roots to refer to the same directory", () => {
    expect(() =>
      createWorkspaceBinding({
        kind: "local",
        hostRoot: "D:\\code\\ohs",
        executionRoot: "/workspace",
      }),
    ).toThrow("Local workspace roots must match");
  });
});
