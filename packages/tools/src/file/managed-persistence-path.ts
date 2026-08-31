import { isAbsolute, relative, resolve } from "node:path";
import { getConfigDir, getProjectMemoryDir } from "@openharness/core";

export type ManagedPersistencePathKind = "user-profile" | "project-memory";

export function managedPersistencePathKind(
  filePath: string,
  cwd: string,
): ManagedPersistencePathKind | null {
  const target = normalizePath(resolve(filePath));
  const userProfile = normalizePath(resolve(getConfigDir(), "USER.md"));
  if (target === userProfile) return "user-profile";

  const memoryDir = normalizePath(resolve(getProjectMemoryDir(cwd)));
  const fromMemoryDir = relative(memoryDir, target);
  if (
    fromMemoryDir === "" ||
    (!fromMemoryDir.startsWith("..") && !isAbsolute(fromMemoryDir))
  ) {
    return "project-memory";
  }

  return null;
}

function normalizePath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}
