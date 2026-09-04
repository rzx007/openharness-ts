import type { IToolRegistry, ToolDefinition } from "@openharness/core";
import { ToolRegistrationError } from "@openharness/core";

import type { OpenHarnessAgentConfiguration } from "./agent-options.js";

export type ToolLimit =
  { kind: "all" } | { kind: "only"; names: ReadonlySet<string> };

export function applyConfiguredTools(
  registry: IToolRegistry,
  configuration: OpenHarnessAgentConfiguration,
): Set<string> {
  const additions = configuration.tools ?? [];
  const overrides = configuration.toolOverrides ?? [];
  const trustedOverrides = new Set(configuration.trustedToolOverrides ?? []);
  const additionNames = assertUniqueToolNames(additions, "tools");
  const overrideNames = assertUniqueToolNames(overrides, "toolOverrides");

  for (const name of trustedOverrides) {
    if (!overrideNames.has(name)) {
      throw new Error(
        `trustedToolOverrides entry "${name}" must also appear in toolOverrides`,
      );
    }
  }

  for (const name of additionNames) {
    if (overrideNames.has(name)) {
      throw new Error(
        `Tool "${name}" cannot appear in both tools and toolOverrides`,
      );
    }
    if (registry.has(name)) {
      throw new ToolRegistrationError(
        "tool_already_registered",
        `Tool "${name}" is already registered by builtin; use toolOverrides`,
      );
    }
  }
  for (const name of overrideNames) {
    if (!registry.has(name)) {
      throw new ToolRegistrationError(
        "tool_override_target_not_found",
        `Tool override target "${name}" is not registered`,
      );
    }
    if (
      trustedOverrides.has(name) &&
      registry.inspect(name)?.source.kind !== "builtin"
    ) {
      throw new Error(
        `trustedToolOverrides entry "${name}" must replace a builtin Tool`,
      );
    }
  }

  for (const tool of additions) registry.register(tool, { kind: "agent" });
  for (const tool of overrides) registry.override(tool, { kind: "agent" });
  return trustedOverrides;
}

function assertUniqueToolNames(
  tools: readonly ToolDefinition[],
  field: "tools" | "toolOverrides",
): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error(`Duplicate Tool "${tool.name}" in ${field}`);
    }
    names.add(tool.name);
  }
  return names;
}

export function createVisibilityToolRegistry(
  inner: IToolRegistry,
  allowedTools: ToolLimit,
  deniedTools: ReadonlySet<string>,
): IToolRegistry {
  return new RuntimeToolRegistry(inner, allowedTools, deniedTools);
}

class RuntimeToolRegistry implements IToolRegistry {
  constructor(
    private readonly inner: IToolRegistry,
    private readonly allowedTools: ToolLimit,
    private readonly deniedTools: ReadonlySet<string>,
  ) {}

  register(tool: ToolDefinition, source?: Parameters<IToolRegistry["register"]>[1]): void {
    this.inner.register(tool, source);
  }

  override(tool: ToolDefinition, source: Parameters<IToolRegistry["override"]>[1]): void {
    this.inner.override(tool, source);
  }

  unregister(name: string): boolean {
    return this.inner.unregister?.(name) ?? false;
  }

  get(name: string): ToolDefinition | undefined {
    const tool = this.inner.get(name);
    return tool && this.isVisible(tool.name) ? tool : undefined;
  }

  getAll(): ToolDefinition[] {
    return this.inner.getAll().filter((tool) => this.isVisible(tool.name));
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  inspect(name: string) {
    return this.isVisible(name) ? this.inner.inspect(name) : undefined;
  }

  internalRegistry(): IToolRegistry {
    return this.inner;
  }

  private isVisible(name: string): boolean {
    if (this.deniedTools.has(name)) return false;
    return (
      this.allowedTools.kind === "all" || this.allowedTools.names.has(name)
    );
  }
}

export function getInternalToolRegistry(registry: IToolRegistry): IToolRegistry {
  return registry instanceof RuntimeToolRegistry
    ? registry.internalRegistry()
    : registry;
}
