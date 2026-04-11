export interface KeyBinding {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
  command: string;
  when?: string;
}

export interface KeyBindingContext {
  activeMode?: string;
  [key: string]: unknown;
}

export class KeyBindingManager {
  private bindings = new Map<string, KeyBinding>();
  private modeBindings = new Map<string, KeyBinding[]>();

  register(binding: KeyBinding): void {
    const id = this.toId(binding);
    this.bindings.set(id, binding);
  }

  registerMode(mode: string, bindings: KeyBinding[]): void {
    this.modeBindings.set(mode, bindings);
  }

  unregister(key: string): boolean {
    return this.bindings.delete(key);
  }

  resolve(input: { key: string; ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean }, context?: KeyBindingContext): KeyBinding | undefined {
    if (context?.activeMode) {
      const modeSpecific = this.modeBindings.get(context.activeMode);
      if (modeSpecific) {
        const found = modeSpecific.find(
          (b) => b.key === input.key
            && !!b.ctrl === !!input.ctrl
            && !!b.alt === !!input.alt
            && !!b.shift === !!input.shift
            && !!b.meta === !!input.meta,
        );
        if (found) return found;
      }
    }
    for (const binding of this.bindings.values()) {
      if (
        binding.key === input.key
        && !!binding.ctrl === !!input.ctrl
        && !!binding.alt === !!input.alt
        && !!binding.shift === !!input.shift
        && !!binding.meta === !!input.meta
      ) {
        return binding;
      }
    }
    return undefined;
  }

  list(): KeyBinding[] {
    return [...this.bindings.values()];
  }

  listModes(): string[] {
    return [...this.modeBindings.keys()];
  }

  private toId(binding: KeyBinding): string {
    const parts: string[] = [];
    if (binding.ctrl) parts.push("ctrl");
    if (binding.alt) parts.push("alt");
    if (binding.shift) parts.push("shift");
    if (binding.meta) parts.push("meta");
    parts.push(binding.key);
    return parts.join("+");
  }
}
