import { ToolRegistry } from "@openharness/core";

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  return registry;
}
