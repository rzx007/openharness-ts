export {
  AgentOperationConflictError,
  createOpenHarnessAgent,
  type AgentCompactResult,
  type AgentInspection,
  type OpenHarnessAgent,
  type OpenHarnessAgentOptions,
  type OpenHarnessAgentState,
  type OpenHarnessAgentSubmitOptions,
} from "./agent.js";
export type { OpenHarnessAgentConfiguration } from "./agent-options.js";
export type { AgentRememberResult } from "./memory-runtime.js";
export type {
  OpenHarnessAgentExtension,
  OpenHarnessExtensionContext,
} from "./extensions.js";
export { discoverOpenHarnessExtensions } from "./extensions.js";
export type {
  AgentChildEnvironmentLease,
  AgentChildEnvironmentProvider,
} from "./child-agent.js";
export {
  buildChildAgentWorktreeSlug,
  computeChildAgentWorktreeBaseDir,
  createChildAgentWorktreeManager,
  createDefaultChildEnvironmentProvider,
  type ChildAgentWorktreeManager,
  type GitRunner,
} from "./child-environment.js";
