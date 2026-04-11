export interface CommandDefinition {
  name: string;
  description: string;
  aliases?: string[];
  args?: CommandArg[];
  handler: (ctx: CommandContext) => Promise<CommandResult>;
}

export interface CommandArg {
  name: string;
  description?: string;
  required?: boolean;
  default?: string;
}

export interface CommandContext {
  args: Record<string, string>;
  raw: string;
}

export interface CommandResult {
  success: boolean;
  output?: string;
  error?: string;
}

export class CommandRegistry {
  private commands = new Map<string, CommandDefinition>();

  register(definition: CommandDefinition): void {
    this.commands.set(definition.name, definition);
    if (definition.aliases) {
      for (const alias of definition.aliases) {
        this.commands.set(alias, definition);
      }
    }
  }

  unregister(name: string): boolean {
    const def = this.commands.get(name);
    if (!def) return false;
    this.commands.delete(name);
    if (def.aliases) {
      for (const alias of def.aliases) {
        this.commands.delete(alias);
      }
    }
    return true;
  }

  get(name: string): CommandDefinition | undefined {
    return this.commands.get(name);
  }

  list(): CommandDefinition[] {
    const seen = new Set<string>();
    const result: CommandDefinition[] = [];
    for (const cmd of this.commands.values()) {
      if (!seen.has(cmd.name)) {
        seen.add(cmd.name);
        result.push(cmd);
      }
    }
    return result;
  }

  async execute(name: string, ctx: CommandContext): Promise<CommandResult> {
    const cmd = this.commands.get(name);
    if (!cmd) {
      return { success: false, error: `Unknown command: ${name}` };
    }
    try {
      return await cmd.handler(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }
}
