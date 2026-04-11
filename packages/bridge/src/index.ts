import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface BridgeSession {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  status: "active" | "paused" | "closed";
  metadata: Record<string, unknown>;
}

export class BridgeManager {
  private sessions = new Map<string, BridgeSession>();
  private storageDir: string;

  constructor(storageDir?: string) {
    this.storageDir = storageDir ?? join(homedir(), ".openharness", "sessions");
  }

  async createSession(name?: string): Promise<BridgeSession> {
    const session: BridgeSession = {
      id: randomUUID().slice(0, 8),
      name: name ?? `session-${Date.now()}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "active",
      metadata: {},
    };
    this.sessions.set(session.id, session);
    await this.persistSession(session);
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
    if (session) {
      session.status = "closed";
      session.updatedAt = Date.now();
      await this.persistSession(session);
    }
  }

  async updateMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
    const session = this.sessions.get(id);
    if (session) {
      Object.assign(session.metadata, metadata);
      session.updatedAt = Date.now();
      await this.persistSession(session);
    }
  }

  async loadPersistedSessions(): Promise<number> {
    try {
      const files = await readdir(this.storageDir);
      let count = 0;
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = await readFile(join(this.storageDir, file), "utf-8");
          const session: BridgeSession = JSON.parse(raw);
          this.sessions.set(session.id, session);
          count++;
        } catch {}
      }
      return count;
    } catch {
      return 0;
    }
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
    try {
      await rm(join(this.storageDir, `${id}.json`));
    } catch {}
  }

  private async persistSession(session: BridgeSession): Promise<void> {
    await mkdir(this.storageDir, { recursive: true });
    await writeFile(
      join(this.storageDir, `${session.id}.json`),
      JSON.stringify(session, null, 2),
      "utf-8"
    );
  }
}
