export interface SessionData {
  id: string;
  name?: string;
  createdAt: number;
  updatedAt: number;
  messages: SessionMessage[];
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  metadata: Record<string, unknown>;
}

export interface SessionMessage {
  type: string;
  content: string;
}

export class SessionStorage {
  private sessions = new Map<string, SessionData>();
  private storageDir: string | undefined;

  constructor(storageDir?: string) {
    this.storageDir = storageDir;
  }

  create(id: string, metadata: Record<string, unknown> = {}): SessionData {
    const now = Date.now();
    const session: SessionData = {
      id,
      createdAt: now,
      updatedAt: now,
      messages: [],
      model: "",
      usage: { inputTokens: 0, outputTokens: 0 },
      metadata,
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): SessionData | undefined {
    return this.sessions.get(id);
  }

  update(id: string, updates: Partial<Omit<SessionData, "id" | "createdAt">>): SessionData | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    Object.assign(session, updates, { updatedAt: Date.now() });
    return session;
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  list(): SessionData[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async saveSnapshot(session: SessionData): Promise<void> {
    if (!this.storageDir) return;
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await mkdir(this.storageDir, { recursive: true });
    const filePath = join(this.storageDir, `${session.id}.json`);
    await writeFile(filePath, JSON.stringify(session, null, 2), "utf-8");
  }

  async loadSnapshot(id: string): Promise<SessionData | undefined> {
    if (this.storageDir) {
      try {
        const { readFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const filePath = join(this.storageDir, `${id}.json`);
        const raw = await readFile(filePath, "utf-8");
        const data = JSON.parse(raw) as SessionData;
        this.sessions.set(data.id, data);
        return data;
      } catch {
        // fall through to in-memory
      }
    }
    return this.sessions.get(id);
  }

  async listSnapshots(): Promise<SessionData[]> {
    if (!this.storageDir) return this.list();
    try {
      const { readdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const files = await readdir(this.storageDir);
      const results: SessionData[] = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const id = file.replace(/\.json$/, "");
        const data = await this.loadSnapshot(id);
        if (data) results.push(data);
      }
      return results.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return this.list();
    }
  }

  async deleteSnapshot(id: string): Promise<boolean> {
    if (this.storageDir) {
      try {
        const { unlink } = await import("node:fs/promises");
        const { join } = await import("node:path");
        await unlink(join(this.storageDir, `${id}.json`));
      } catch {
        // file may not exist
      }
    }
    return this.sessions.delete(id);
  }
}
