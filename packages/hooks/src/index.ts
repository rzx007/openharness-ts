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
    if (this.hooks.has(hook.id)) {
      throw new Error(`Hook already registered: ${hook.id}`);
    }
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

  private async executeCommand(
    _command: string,
    _signal: AbortSignal
  ): Promise<void> {}

  private async executeHttp(
    _url: string,
    _method: string,
    _body: unknown,
    _signal: AbortSignal
  ): Promise<void> {}
}
