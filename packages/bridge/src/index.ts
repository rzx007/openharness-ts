export interface BridgeSession {
  id: string;
  name: string;
  createdAt: Date;
  status: "active" | "paused" | "closed";
}

export class BridgeManager {
  private sessions = new Map<string, BridgeSession>();

  async createSession(name: string): Promise<BridgeSession> {
    const session: BridgeSession = {
      id: crypto.randomUUID(),
      name,
      createdAt: new Date(),
      status: "active",
    };
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(id: string): BridgeSession | undefined {
    return this.sessions.get(id);
  }

  listSessions(): BridgeSession[] {
    return [...this.sessions.values()];
  }

  async closeSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) session.status = "closed";
  }
}
