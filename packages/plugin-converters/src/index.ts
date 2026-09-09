export * from "./core/converter.js";
export * from "./core/digest.js";
export * from "./core/registry.js";
export * from "./core/plan.js";
export * from "./core/report.js";
export * from "./core/reconversion.js";
export * from "./claude-code/detector.js";
export * from "./claude-code/parser.js";
export * from "./claude-code/mappings.js";
export * from "./claude-code/convert-agents.js";
export * from "./claude-code/converter.js";
export * from "./codex/converter.js";

import { ConverterRegistry } from "./core/registry.js";
import { ClaudeCodePluginConverter } from "./claude-code/converter.js";
import { CodexPluginConverter } from "./codex/converter.js";
export function createBuiltinConverterRegistry(): ConverterRegistry {
  const registry = new ConverterRegistry();
  registry.register(new ClaudeCodePluginConverter());
  registry.register(new CodexPluginConverter());
  return registry;
}
