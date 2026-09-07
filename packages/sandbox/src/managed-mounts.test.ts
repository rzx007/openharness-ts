import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createDesktopManagedMounts,
  prepareDesktopManagedMounts,
  resolveContainerWorkspacePath,
} from "./managed-mounts.js";

describe("managed Docker mounts", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
    );
  });
  it("uses /workspace for every host platform", () => {
    expect(resolveContainerWorkspacePath("D:\\code\\ohs", "win32")).toBe(
      "/workspace",
    );
    expect(resolveContainerWorkspacePath("/home/me/ohs", "linux")).toBe(
      "/workspace",
    );
    expect(resolveContainerWorkspacePath("/Users/me/ohs", "darwin")).toBe(
      "/workspace",
    );
  });

  it("creates exactly the workspace and user Skill rw mounts", () => {
    expect(
      createDesktopManagedMounts({
        workspaceRoot: "D:\\code\\ohs",
        userSkillsRoot: "C:\\Users\\me\\.openharness-ts\\skills",
      }),
    ).toEqual([
      {
        purpose: "workspace",
        source: resolve("D:\\code\\ohs"),
        target: "/workspace",
        mode: "rw",
      },
      {
        purpose: "user_skills",
        source: resolve("C:\\Users\\me\\.openharness-ts\\skills"),
        target: "/opt/openharness/skills",
        mode: "rw",
      },
    ]);
  });

  it("creates a missing Skill directory after validating the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohs-managed-mounts-"));
    temporaryRoots.push(root);
    const skills = join(root, "config", "skills");

    const mounts = await prepareDesktopManagedMounts({
      workspaceRoot: root,
      userSkillsRoot: skills,
    });

    expect((await stat(skills)).isDirectory()).toBe(true);
    expect(mounts[1]).toMatchObject({
      source: resolve(skills),
      target: "/opt/openharness/skills",
      mode: "rw",
    });
  });

  it("rejects a workspace path that is not a directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohs-managed-mounts-file-"));
    temporaryRoots.push(root);
    const workspaceFile = join(root, "workspace.txt");
    await writeFile(workspaceFile, "not a directory", "utf-8");

    await expect(
      prepareDesktopManagedMounts({
        workspaceRoot: workspaceFile,
        userSkillsRoot: join(root, "skills"),
      }),
    ).rejects.toThrow("Managed Docker workspace must be a directory");
    await expect(readFile(workspaceFile, "utf-8")).resolves.toBe(
      "not a directory",
    );
  });
});
