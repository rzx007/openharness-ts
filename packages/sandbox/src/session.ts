import { resolve } from "node:path";
import type { SandboxSession } from "./types.js";

const activeSessions = new Map<string, SandboxSession>();
let lastActiveKey: string | null = null;

function keyForCwd(cwd: string): string {
  const resolved = resolve(cwd);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function getActiveSandboxSession(cwd?: string): SandboxSession | null {
  if (cwd) return activeSessions.get(keyForCwd(cwd)) ?? null;
  return lastActiveKey ? activeSessions.get(lastActiveKey) ?? null : null;
}

export function setActiveSandboxSession(session: SandboxSession | null, cwd?: string): void {
  if (session === null) {
    if (cwd) {
      const key = keyForCwd(cwd);
      activeSessions.delete(key);
      if (lastActiveKey === key) lastActiveKey = activeSessions.keys().next().value ?? null;
      return;
    }
    activeSessions.clear();
    lastActiveKey = null;
    return;
  }

  const key = keyForCwd(cwd ?? session.cwd);
  activeSessions.set(key, session);
  lastActiveKey = key;
}

export function isSandboxSessionActive(cwd?: string): boolean {
  return getActiveSandboxSession(cwd)?.active === true;
}

export async function stopActiveSandboxSession(cwd?: string): Promise<void> {
  const session = getActiveSandboxSession(cwd);
  if (session === null) return;
  try {
    await session.stop();
  } finally {
    setActiveSandboxSession(null, cwd ?? session.cwd);
  }
}

export function stopActiveSandboxSessionSync(cwd?: string): void {
  const session = getActiveSandboxSession(cwd);
  if (session === null) return;
  try {
    session.stopSync?.();
  } finally {
    setActiveSandboxSession(null, cwd ?? session.cwd);
  }
}
