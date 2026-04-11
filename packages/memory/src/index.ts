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

export class MemoryManager {
  private entries = new Map<string, MemoryEntry>();
  private maxEntries: number;

  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries;
  }

  async add(
    content: string,
    tags?: string[],
    metadata?: Record<string, unknown>
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
    return entry;
  }

  async get(id: string): Promise<MemoryEntry | undefined> {
    return this.entries.get(id);
  }

  async update(
    id: string,
    updates: Partial<Pick<MemoryEntry, "content" | "tags" | "metadata">>
  ): Promise<MemoryEntry | undefined> {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (updates.content !== undefined) entry.content = updates.content;
    if (updates.tags !== undefined) entry.tags = updates.tags;
    if (updates.metadata !== undefined) entry.metadata = updates.metadata;
    entry.updatedAt = Date.now();
    return entry;
  }

  async delete(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }

  async search(options: MemorySearchOptions): Promise<MemorySearchResult[]> {
    const { query, tags, limit = 10 } = options;
    const queryLower = query.toLowerCase();
    const results: MemorySearchResult[] = [];

    for (const entry of this.entries.values()) {
      if (tags?.length && !tags.some((t) => entry.tags?.includes(t))) {
        continue;
      }
      const score = this.computeScore(entry, queryLower);
      if (score > 0) {
        results.push({ entry, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  async getAll(): Promise<readonly MemoryEntry[]> {
    return [...this.entries.values()];
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }

  count(): number {
    return this.entries.size;
  }

  private computeScore(entry: MemoryEntry, queryLower: string): number {
    const contentLower = entry.content.toLowerCase();
    let score = 0;
    let idx = contentLower.indexOf(queryLower);
    while (idx !== -1) {
      score += 1;
      idx = contentLower.indexOf(queryLower, idx + 1);
    }
    return score;
  }

  private generateId(): string {
    return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = [...this.entries.values()].sort(
        (a, b) => a.createdAt - b.createdAt
      )[0];
      if (oldest) this.entries.delete(oldest.id);
      else break;
    }
  }
}
