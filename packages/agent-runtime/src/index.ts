export {
  AgentOperationConflictError,
  type AgentCompactResult,
  type AgentInspection,
  type OpenHarnessAgent,
  type OpenHarnessAgentOptions,
  type OpenHarnessAgentState,
  type OpenHarnessAgentSubmitOptions,
} from "./agent.js";
export {
  createDefaultNodeAgent,
} from "./default-agent.js";
export type {
  AgentCapabilityOverrides,
  AgentEffectOverrides,
  /** @deprecated Migration-only legacy type; remove in phase 1 task 3. */
  AgentHostCapabilities,
  /** @deprecated Migration-only legacy type; remove in phase 1 task 3. */
  AgentPermissionHost,
  CapabilityOverride,
  ObservableJobProducer,
  OpenHarnessAgentConfiguration,
} from "./agent-options.js";
export {
  assertJobConfiguration,
  disabledCapability,
  resolveCapability,
  toCapabilitySnapshot,
  unavailableCapability,
  type AgentCapabilitySnapshot,
  type CapabilitySnapshot,
  type ResolvedAgentCapabilities,
  type ResolvedCapability,
} from "./capability-resolution.js";
export {
  createAgentKernel,
  createBasicAgentKernelRuntime,
  type BasicAgentKernelRuntimeOptions,
  type AgentKernelOptions,
  type AgentKernelRuntime,
  type AgentKernelRuntimeContext,
} from "./kernel.js";
export type { AgentRememberResult } from "./memory-runtime.js";
export {
  createRememberTool,
  type RememberToolOptions,
} from "./remember-tool.js";
export type {
  OpenHarnessAgentExtension,
  OpenHarnessExtensionContext,
} from "./extensions.js";
export { discoverOpenHarnessExtensions } from "./extensions.js";
export {
  activateNativePluginTools,
  type NativeToolActivationResult,
} from "./native-tools/activate.js";
export {
  NativeToolHost,
  NativeToolHostError,
  type NativeToolHostOptions,
  type NativeToolHostState,
} from "./native-tools/tool-host.js";
export {
  getNativeToolRuntimeSnapshot,
  type NativeToolRuntimeSnapshot,
} from "./native-tools/status.js";
export type {
  AgentChildEnvironmentLease,
  AgentChildEnvironmentProvider,
} from "./child-agent.js";
export {
  buildChildAgentWorktreeSlug,
  computeChildAgentWorktreeBaseDir,
  createChildAgentWorktreeManager,
  createDefaultChildEnvironmentProvider,
  createInProcessChildEnvironmentProvider,
  type ChildAgentWorktreeManager,
  type GitRunner,
} from "./child-environment.js";
