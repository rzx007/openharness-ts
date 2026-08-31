import type { ContextScope } from "@openharness/context";

export class ContextScopeLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(scope: ContextScope, scopeKey: string, callback: () => Promise<T>): Promise<T> {
    const key = `${scope}:${scopeKey}`;
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    this.tails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await callback();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
