export interface SessionData {
  id: string;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

export class SessionStorage {
  private sessions = new Map<string, SessionData>();

  create(id: string, metadata: Record<string, unknown> = {}): SessionData {
    const now = Date.now();
    const session: SessionData = { id, createdAt: now, updatedAt: now, metadata };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): SessionData | undefined {
    return this.sessions.get(id);
  }

  update(id: string, metadata: Partial<SessionData["metadata"]>): SessionData | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    Object.assign(session.metadata, metadata);
    session.updatedAt = Date.now();
    return session;
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  list(): SessionData[] {
    return [...this.sessions.values()];
  }
}
