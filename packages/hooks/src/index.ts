import { spawn } from "node:child_process";
import type {
  HookEvent,
  HookType,
  HookDefinition,
  HookResult,
  IHookExecutor,
} from "@openharness/core";

export type { HookEvent, HookType, HookDefinition, HookResult };

export interface DetailedHookResult {
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
  ): Promise<HookResult> {
    const matching = this.getHooksForEvent(event);

    for (const hook of matching) {
      const result = await this.executeSingle(hook, context);
      if (result.blocked) {
        return result;
      }
    }

    return { blocked: false };
  }

  async executeWithResults(
    event: HookEvent,
    context: Record<string, unknown>
  ): Promise<DetailedHookResult[]> {
    const matching = this.getHooksForEvent(event);
    const results: DetailedHookResult[] = [];

    for (const hook of matching) {
      const start = performance.now();
      const hookResult = await this.executeSingle(hook, context);
      const durationMs = performance.now() - start;
      results.push({
        hookId: hook.id,
        success: !hookResult.blocked,
        durationMs,
        error: hookResult.blocked ? new Error(hookResult.reason ?? "blocked") : undefined,
      });
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
    context: Record<string, unknown>
  ): Promise<HookResult> {
    const timeout = hook.timeout ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      switch (hook.type) {
        case "command":
          return await this.executeCommand(hook.command, controller.signal);
        case "http":
          return await this.executeHttp(
            hook.url,
            hook.method ?? "POST",
            context,
            controller.signal
          );
        case "prompt":
        case "agent":
          return { blocked: false };
      }
    } catch {
      return { blocked: false };
    } finally {
      clearTimeout(timer);
    }
  }

  async executeCommand(
    command: string,
    signal: AbortSignal
  ): Promise<HookResult> {
    return new Promise<HookResult>((resolve, reject) => {
      const proc = spawn(command, [], {
        shell: true,
        signal,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 2) {
          const reason = stdout.trim() || stderr.trim() || "blocked by command hook";
          resolve({ blocked: true, reason });
        } else if (code === 0) {
          resolve({ blocked: false });
        } else {
          resolve({ blocked: false });
        }
      });

      proc.on("error", (err) => {
        resolve({ blocked: false, reason: err.message });
      });
    });
  }

  async executeHttp(
    url: string,
    method: string,
    body: unknown,
    signal: AbortSignal
  ): Promise<HookResult> {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      return { blocked: false, reason: `Hook HTTP request failed: ${response.status}` };
    }

    try {
      const json = await response.json() as Record<string, unknown>;
      if (json.blocked === true) {
        return { blocked: true, reason: (json.reason as string) ?? "blocked by HTTP hook" };
      }
    } catch {}

    return { blocked: false };
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
