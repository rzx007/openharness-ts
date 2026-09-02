import type {
  RegisteredToolInspection,
  ToolDefinition,
  ToolRegistrationSource,
  ToolRegistry as IToolRegistry,
} from "../index";

type ToolRegistrationErrorCode =
  | "tool_already_registered"
  | "tool_override_target_not_found";

interface ToolEntry {
  definition: ToolDefinition;
  source: ToolRegistrationSource;
  overrides?: ToolRegistrationSource;
}

export class ToolRegistrationError extends Error {
  constructor(
    readonly code: ToolRegistrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ToolRegistrationError";
  }
}

export class ToolRegistry implements IToolRegistry {
  private tools = new Map<string, ToolEntry>();

  register(
    tool: ToolDefinition,
    source: ToolRegistrationSource = { kind: "runtime" },
  ): void {
    const existing = this.tools.get(tool.name);
    if (existing) {
      throw new ToolRegistrationError(
        "tool_already_registered",
        `Tool "${tool.name}" is already registered by ${formatSource(existing.source)}; use an explicit override`,
      );
    }
    this.tools.set(tool.name, { definition: tool, source });
  }

  override(tool: ToolDefinition, source: ToolRegistrationSource): void {
    const existing = this.tools.get(tool.name);
    if (!existing) {
      throw new ToolRegistrationError(
        "tool_override_target_not_found",
        `Cannot override unknown Tool "${tool.name}"`,
      );
    }
    this.tools.set(tool.name, {
      definition: tool,
      source,
      overrides: existing.source,
    });
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.definition;
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values(), (entry) => entry.definition);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  inspect(name: string): RegisteredToolInspection | undefined {
    const entry = this.tools.get(name);
    if (!entry) return undefined;
    return {
      name,
      source: entry.source,
      ...(entry.overrides ? { overrides: entry.overrides } : {}),
    };
  }
}

function formatSource(source: ToolRegistrationSource): string {
  return source.id ? `${source.kind}:${source.id}` : source.kind;
}
