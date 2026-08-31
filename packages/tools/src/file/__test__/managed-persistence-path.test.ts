import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigDir, getProjectMemoryDir } from "@openharness/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { managedPersistencePathKind } from "../managed-persistence-path.js";

describe("managedPersistencePathKind", () => {
  let configDir: string;
  let cwd: string;
  let oldConfigDir: string | undefined;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "oh-managed-config-"));
    cwd = await mkdtemp(join(tmpdir(), "oh-managed-project-"));
    oldConfigDir = process.env.OPENHARNESS_CONFIG_DIR;
    process.env.OPENHARNESS_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (oldConfigDir === undefined) delete process.env.OPENHARNESS_CONFIG_DIR;
    else process.env.OPENHARNESS_CONFIG_DIR = oldConfigDir;
    await rm(configDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  it("recognizes only the managed USER.md file", () => {
    expect(managedPersistencePathKind(join(getConfigDir(), "USER.md"), cwd))
      .toBe("user-profile");
    expect(managedPersistencePathKind(join(cwd, "USER.md"), cwd)).toBeNull();
    expect(managedPersistencePathKind(join(getConfigDir(), "USER.md.backup"), cwd)).toBeNull();
  });

  it("recognizes the project memory directory and descendants without matching similar prefixes", () => {
    const memoryDir = getProjectMemoryDir(cwd);

    expect(managedPersistencePathKind(memoryDir, cwd)).toBe("project-memory");
    expect(managedPersistencePathKind(join(memoryDir, "entry.md"), cwd)).toBe("project-memory");
    expect(managedPersistencePathKind(join(`${memoryDir}-backup`, "entry.md"), cwd)).toBeNull();
  });
});
