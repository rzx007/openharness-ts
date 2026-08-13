import { join, resolve } from "node:path";
import process from "node:process";

import { getProjectConfigDir } from "@openharness/core";

import { TaskManager } from "./task-manager.js";
import type { TaskManagerScope } from "./types.js";

let defaultManager: TaskManager | undefined;
const scopedManagers = new Map<string, TaskManager>();

function normalizeCwd(cwd: string): string {
  const root = resolve(cwd);
  return process.platform === "win32" ? root.toLowerCase() : root;
}

function normalizeSessionId(sessionId: string | undefined): string | undefined {
  const trimmed = sessionId?.trim();
  return trimmed || undefined;
}

function managerKey(scope: TaskManagerScope): string {
  const cwd = normalizeCwd(scope.cwd);
  const sessionId = normalizeSessionId(scope.sessionId);
  return sessionId ? `${cwd}::session=${sessionId}` : cwd;
}

function scopedTasksDir(scope: TaskManagerScope): string {
  const sessionId = normalizeSessionId(scope.sessionId);
  if (!sessionId) return join(getProjectConfigDir(scope.cwd), "tasks");
  const safeSessionId = sessionId.replace(/[^A-Za-z0-9._-]/g, "_") || "default";
  return join(getProjectConfigDir(scope.cwd), "tasks", "sessions", safeSessionId);
}

export function getTaskManager(scope?: string | TaskManagerScope): TaskManager {
  if (scope) {
    const normalizedScope = typeof scope === "string" ? { cwd: scope } : scope;
    const key = managerKey(normalizedScope);
    let manager = scopedManagers.get(key);
    if (!manager) {
      manager = new TaskManager(scopedTasksDir(normalizedScope));
      scopedManagers.set(key, manager);
    }
    return manager;
  }
  if (!defaultManager) defaultManager = new TaskManager();
  return defaultManager;
}

export function resetTaskManager(scope?: string | TaskManagerScope): void {
  if (scope) {
    const normalizedScope = typeof scope === "string" ? { cwd: scope } : scope;
    const key = managerKey(normalizedScope);
    const sessionId = normalizeSessionId(normalizedScope.sessionId);
    const keys = sessionId
      ? [key]
      : [...scopedManagers.keys()].filter((candidate) => candidate === key || candidate.startsWith(`${key}::session=`));
    for (const candidate of keys) {
      scopedManagers.get(candidate)?.close();
      scopedManagers.delete(candidate);
    }
    return;
  }
  defaultManager?.close();
  defaultManager = undefined;
  for (const manager of scopedManagers.values()) manager.close();
  scopedManagers.clear();
}
