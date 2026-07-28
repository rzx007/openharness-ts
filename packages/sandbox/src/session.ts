import type { SandboxSession } from "./types.js";

let activeSession: SandboxSession | null = null;

export function getActiveSandboxSession(): SandboxSession | null {
  return activeSession;
}

export function setActiveSandboxSession(session: SandboxSession | null): void {
  activeSession = session;
}

export function isSandboxSessionActive(): boolean {
  return activeSession?.active === true;
}

export async function stopActiveSandboxSession(): Promise<void> {
  if (activeSession === null) return;
  try {
    await activeSession.stop();
  } finally {
    activeSession = null;
  }
}

export function stopActiveSandboxSessionSync(): void {
  if (activeSession === null) return;
  try {
    activeSession.stopSync?.();
  } finally {
    activeSession = null;
  }
}
