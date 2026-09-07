import { resolve } from "node:path";
import type { SandboxSession } from "./types.js";

const activeSessions = new Map<string, SandboxSession>();
const aliasReferences = new Map<string, { session: SandboxSession; count: number }>();
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
    aliasReferences.clear();
    lastActiveKey = null;
    return;
  }

  const key = keyForScope(scope ?? session.cwd);
  activeSessions.set(key, session);
  lastActiveKey = key;
}

export function acquireSandboxSessionAlias(input: {
  cwd: string;
  sourceSessionId: string;
  targetSessionId: string;
}): () => void {
  if (input.sourceSessionId === input.targetSessionId) return () => {};
  const source = getActiveSandboxSession({ cwd: input.cwd, sessionId: input.sourceSessionId });
  if (!source) throw new Error(`Source sandbox session is not active: ${input.sourceSessionId}`);
  const targetScope = { cwd: input.cwd, sessionId: input.targetSessionId };
  const targetKey = keyForScope(targetScope);
  const existing = activeSessions.get(targetKey);
  if (existing && existing !== source) {
    throw new Error(`Sandbox session alias conflicts with an active session: ${input.targetSessionId}`);
  }
  const reference = aliasReferences.get(targetKey);
  if (reference && reference.session !== source) {
    throw new Error(`Sandbox session alias belongs to another environment: ${input.targetSessionId}`);
  }
  activeSessions.set(targetKey, source);
  aliasReferences.set(targetKey, {
    session: source,
    count: (reference?.count ?? 0) + 1,
  });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = aliasReferences.get(targetKey);
    if (!current || current.session !== source) return;
    if (current.count > 1) {
      current.count -= 1;
      return;
    }
    aliasReferences.delete(targetKey);
    if (activeSessions.get(targetKey) === source) activeSessions.delete(targetKey);
  };
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
