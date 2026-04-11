import { spawn } from "node:child_process";
import type {
  HookEvent,
  HookType,
  HookDefinition,
  IHookExecutor,
} from "@openharness/core";

export type { HookEvent, HookType, HookDefinition };

export interface HookResult {
  hookId: string;
  success: boolean;
  error?: Error;
  durationMs: number;
}

export class HookExecutor implements IHookExecutor {
  private hooks = new Map<string, HookDefinition>();

  register(hook: HookDefinition): void {
    this.hooks.set(hook.id, hook);
  }

  unregister(hookId: string): void {
    this.hooks.delete(hookId);
  }

  async execute(
    event: HookEvent,
    context: Record<string, unknown>
  ): Promise<void> {
    const matching = this.getHooksForEvent(event);

    for (const hook of matching) {
      try {
        await this.executeSingle(hook, context);
      } catch {
        // hooks should not throw, errors are logged internally
      }
    }
  }

  async executeWithResults(
    event: HookEvent,
    context: Record<string, unknown>
  ): Promise<HookResult[]> {
    const matching = this.getHooksForEvent(event);
    const results: HookResult[] = [];

    for (const hook of matching) {
      const start = performance.now();
      try {
        await this.executeSingle(hook, context);
        results.push({
          hookId: hook.id,
          success: true,
          durationMs: performance.now() - start,
        });
      } catch (err) {
        results.push({
          hookId: hook.id,
          success: false,
          error: err instanceof Error ? err : new Error(String(err)),
          durationMs: performance.now() - start,
        });
      }
    }

    return results;
  }

  getHooksForEvent(event: HookEvent): HookDefinition[] {
    return [...this.hooks.values()].filter(
      (h) => h.event === event && h.enabled
    );
  }

  getAll(): readonly HookDefinition[] {
    return [...this.hooks.values()];
  }

  private async executeSingle(
    hook: HookDefinition,
    _context: Record<string, unknown>
  ): Promise<void> {
    const timeout = hook.timeout ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      switch (hook.type) {
        case "command":
          await this.executeCommand(hook.command, controller.signal);
          break;
        case "http":
          await this.executeHttp(
            hook.url,
            hook.method ?? "POST",
            _context,
            controller.signal
          );
          break;
        case "prompt":
        case "agent":
          break;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async executeCommand(
    command: string,
    signal: AbortSignal
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const proc = spawn(command, [], {
        shell: true,
        signal,
      });

      let stderr = "";

      proc.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Hook command exited with code ${code}: ${stderr}`));
      });

      proc.on("error", (err) => {
        reject(err);
      });
    });
  }

  async executeHttp(
    url: string,
    method: string,
    body: unknown,
    signal: AbortSignal
  ): Promise<void> {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Hook HTTP request failed: ${response.status} ${response.statusText}`);
    }
  }
}

export class HookLoader {
  private executor: HookExecutor;
  private watchers: Array<{ close: () => void }> = [];

  constructor(executor?: HookExecutor) {
    this.executor = executor ?? new HookExecutor();
  }

  async loadFromConfig(
    hooks: HookDefinition[]
  ): Promise<number> {
    let count = 0;
    for (const hook of hooks) {
      this.executor.register(hook);
      count++;
    }
    return count;
  }

  async loadFromDirectory(
    dir: string,
    pattern = "*.hook.{js,ts}"
  ): Promise<number> {
    const { readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    let count = 0;
    try {
      const entries = await readdir(dir);
      for (const file of entries) {
        if (!file.endsWith(".hook.js") && !file.endsWith(".hook.ts")) continue;
        try {
          const mod = await import(join(dir, file));
          const hooks: HookDefinition[] = mod?.hooks ?? mod?.default?.hooks ?? [];
          for (const hook of hooks) {
            this.executor.register(hook);
            count++;
          }
        } catch {}
      }
    } catch {}
    return count;
  }

  watch(directory: string, intervalMs = 5000): void {
    const timer = setInterval(() => {
      this.loadFromDirectory(directory).catch(() => {});
    }, intervalMs);
    this.watchers.push({ close: () => clearInterval(timer) });
  }

  stopWatching(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  getExecutor(): HookExecutor {
    return this.executor;
  }
}
