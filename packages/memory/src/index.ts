import { join } from "node:path";
import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";

export interface MemoryEntry {
  id: string;
  content: string;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

export interface MemorySearchOptions {
  query: string;
  tags?: string[];
  limit?: number;
}

const METADATA_WEIGHT = 2;
const CONTENT_WEIGHT = 1;

export class MemoryManager {
  private entries = new Map<string, MemoryEntry>();
  private maxEntries: number;
  private storageDir: string | undefined;

  constructor(maxEntries = 1000, storageDir?: string) {
    this.maxEntries = maxEntries;
    this.storageDir = storageDir;
  }

  async add(
    content: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
  ): Promise<MemoryEntry> {
    const id = this.generateId();
    const now = Date.now();
    const entry: MemoryEntry = {
      id,
      content,
      tags,
      createdAt: now,
      updatedAt: now,
      metadata,
    };
    this.entries.set(id, entry);
    this.evictIfNeeded();

    if (this.storageDir) {
      await this.persistEntry(entry);
    }

    return entry;
  }

  async get(id: string): Promise<MemoryEntry | undefined> {
    const cached = this.entries.get(id);
    if (cached) return cached;
    if (this.storageDir) {
      return this.loadEntry(id);
    }
    return undefined;
  }

  async update(
    id: string,
    updates: Partial<Pick<MemoryEntry, "content" | "tags" | "metadata">>,
  ): Promise<MemoryEntry | undefined> {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (updates.content !== undefined) entry.content = updates.content;
    if (updates.tags !== undefined) entry.tags = updates.tags;
    if (updates.metadata !== undefined) entry.metadata = updates.metadata;
    entry.updatedAt = Date.now();

    if (this.storageDir) {
      await this.persistEntry(entry);
    }

    return entry;
  }

  async delete(id: string): Promise<boolean> {
    const deleted = this.entries.delete(id);
    if (deleted && this.storageDir) {
      await this.removeEntryFile(id);
    }
    return deleted;
  }

  async search(options: MemorySearchOptions): Promise<MemorySearchResult[]> {
    const { query, tags, limit = 10 } = options;
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(Boolean);
    const results: MemorySearchResult[] = [];

    const allEntries = await this.getAll();

    for (const entry of allEntries) {
      if (tags?.length && !tags.some((t) => entry.tags?.includes(t))) {
        continue;
      }
      const score = this.computeScore(entry, queryLower, queryTerms);
      if (score > 0) {
        results.push({ entry, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  async getAll(): Promise<readonly MemoryEntry[]> {
    if (this.storageDir && this.entries.size === 0) {
      await this.loadAllEntries();
    }
    return [...this.entries.values()];
  }

  async clear(): Promise<void> {
    this.entries.clear();
    if (this.storageDir) {
      try {
        const files = await readdir(this.storageDir);
        for (const file of files) {
          if (file.endsWith(".json")) {
            await unlink(join(this.storageDir, file));
          }
        }
      } catch {
        // directory may not exist
      }
    }
  }

  count(): number {
    return this.entries.size;
  }

  async saveToFile(filePath: string): Promise<void> {
    await mkdir(join(filePath, ".."), { recursive: true });
    const data = [...this.entries.values()];
    await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  async loadFromFile(filePath: string): Promise<number> {
    try {
      const raw = await readFile(filePath, "utf-8");
      const data: MemoryEntry[] = JSON.parse(raw);
      for (const entry of data) {
        this.entries.set(entry.id, entry);
      }
      return data.length;
    } catch {
      return 0;
    }
  }

  buildMemoryPrompt(maxEntries = 10): string {
    const entries = [...this.entries.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, maxEntries);
    if (!entries.length) return "";
    const lines = ["<memory>", "Relevant memories from previous interactions:"];
    for (const entry of entries) {
      const tags = entry.tags?.length ? ` [${entry.tags.join(", ")}]` : "";
      lines.push(`- ${entry.content}${tags}`);
    }
    lines.push("</memory>");
    return lines.join("\n");
  }

  private computeScore(
    entry: MemoryEntry,
    queryLower: string,
    queryTerms: string[],
  ): number {
    let score = 0;

    const contentLower = entry.content.toLowerCase();
    for (const term of queryTerms) {
      let idx = contentLower.indexOf(term);
      while (idx !== -1) {
        score += CONTENT_WEIGHT;
        idx = contentLower.indexOf(term, idx + 1);
      }
    }

    if (entry.metadata) {
      const metaStr = JSON.stringify(entry.metadata).toLowerCase();
      for (const term of queryTerms) {
        let idx = metaStr.indexOf(term);
        while (idx !== -1) {
          score += METADATA_WEIGHT;
          idx = metaStr.indexOf(term, idx + 1);
        }
      }
    }

    if (entry.tags) {
      for (const tag of entry.tags) {
        for (const term of queryTerms) {
          if (tag.toLowerCase().includes(term)) {
            score += METADATA_WEIGHT;
          }
        }
      }
    }

    return score;
  }

  private generateId(): string {
    return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = [...this.entries.values()].sort(
        (a, b) => a.createdAt - b.createdAt,
      )[0];
      if (oldest) this.entries.delete(oldest.id);
      else break;
    }
  }

  private async persistEntry(entry: MemoryEntry): Promise<void> {
    if (!this.storageDir) return;
    await mkdir(this.storageDir, { recursive: true });
    const filePath = join(this.storageDir, `${entry.id}.json`);
    await writeFile(filePath, JSON.stringify(entry, null, 2), "utf-8");
  }

  private async loadEntry(id: string): Promise<MemoryEntry | undefined> {
    if (!this.storageDir) return undefined;
    try {
      const filePath = join(this.storageDir, `${id}.json`);
      const raw = await readFile(filePath, "utf-8");
      const entry = JSON.parse(raw) as MemoryEntry;
      this.entries.set(entry.id, entry);
      return entry;
    } catch {
      return undefined;
    }
  }

  private async removeEntryFile(id: string): Promise<void> {
    if (!this.storageDir) return;
    try {
      await unlink(join(this.storageDir, `${id}.json`));
    } catch {
      // file may not exist
    }
  }

  private async loadAllEntries(): Promise<void> {
    if (!this.storageDir) return;
    try {
      const files = await readdir(this.storageDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const id = file.replace(/\.json$/, "");
        if (!this.entries.has(id)) {
          await this.loadEntry(id);
        }
      }
    } catch {
      // directory may not exist
    }
  }
}
