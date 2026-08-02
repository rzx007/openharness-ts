import { resolve } from "node:path";
import type { SandboxSession } from "./types.js";

const activeSessions = new Map<string, SandboxSession>();
let lastActiveKey: string | null = null;

export interface SandboxSessionScope {
  cwd: string;
  sessionId?: string;
}

export type SandboxSessionLookup = string | SandboxSessionScope;

function normalizeCwd(cwd: string): string {
  const resolved = resolve(cwd);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizeSessionId(sessionId: string | undefined): string | undefined {
  const trimmed = sessionId?.trim();
  return trimmed ? trimmed : undefined;
}

function keyForScope(scope: SandboxSessionLookup): string {
  if (typeof scope === "string") {
    return normalizeCwd(scope);
  }
  const cwd = normalizeCwd(scope.cwd);
  const sessionId = normalizeSessionId(scope.sessionId);
  return sessionId ? `${cwd}::session=${sessionId}` : cwd;
}

export function getActiveSandboxSession(scope?: SandboxSessionLookup): SandboxSession | null {
  if (scope !== undefined) return activeSessions.get(keyForScope(scope)) ?? null;
  return lastActiveKey ? activeSessions.get(lastActiveKey) ?? null : null;
}

export function setActiveSandboxSession(
  session: SandboxSession | null,
  scope?: SandboxSessionLookup,
): void {
  if (session === null) {
    if (scope !== undefined) {
      const key = keyForScope(scope);
      activeSessions.delete(key);
      if (lastActiveKey === key) lastActiveKey = activeSessions.keys().next().value ?? null;
      return;
    }
    activeSessions.clear();
    lastActiveKey = null;
    return;
  }

  const key = keyForScope(scope ?? session.cwd);
  activeSessions.set(key, session);
  lastActiveKey = key;
}

export function isSandboxSessionActive(scope?: SandboxSessionLookup): boolean {
  return getActiveSandboxSession(scope)?.active === true;
}

export async function stopActiveSandboxSession(scope?: SandboxSessionLookup): Promise<void> {
  const session = getActiveSandboxSession(scope);
  if (session === null) return;
  try {
    await session.stop();
  } finally {
    clearActiveSandboxEntry(session, scope);
  }
}

export function stopActiveSandboxSessionSync(scope?: SandboxSessionLookup): void {
  const session = getActiveSandboxSession(scope);
  if (session === null) return;
  try {
    session.stopSync?.();
  } finally {
    clearActiveSandboxEntry(session, scope);
  }
}

function clearActiveSandboxEntry(
  session: SandboxSession,
  scope?: SandboxSessionLookup,
): void {
  if (scope !== undefined) {
    setActiveSandboxSession(null, scope);
    return;
  }
  for (const [key, value] of activeSessions) {
    if (value !== session) continue;
    activeSessions.delete(key);
    if (lastActiveKey === key) lastActiveKey = activeSessions.keys().next().value ?? null;
    return;
  }
}
