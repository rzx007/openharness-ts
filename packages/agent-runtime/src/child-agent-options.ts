import type { AgentChildSpawnInput, Settings } from "@openharness/core";

import type { OpenHarnessAgentOptions } from "./agent.js";
import type {
  AgentCapabilityOverrides,
  AgentEffectOverrides,
  OpenHarnessAgentConfiguration,
} from "./agent-options.js";

export interface DeriveChildAgentOptionsInput {
  configuration: OpenHarnessAgentConfiguration;
  settings: Settings;
  capabilityOverrides?: AgentCapabilityOverrides;
  effects?: AgentEffectOverrides;
  child: AgentChildSpawnInput;
  cwd: string;
  sessionId: string;
}

/** Derive one child runtime without widening the host's tool or capability boundary. */
export function deriveChildAgentOptions(
  input: DeriveChildAgentOptionsInput,
): OpenHarnessAgentOptions {
  const { configuration, child } = input;
  return {
    ...configuration,
    settings: input.settings,
    cwd: input.cwd,
    sessionId: input.sessionId,
    model: child.model ?? configuration.model,
    systemPrompt: child.systemPrompt ?? configuration.systemPrompt,
    permissionMode: child.permissionMode ?? configuration.permissionMode,
    hostToolCeiling: configuration.hostToolCeiling,
    roleAllowedTools: child.allowedTools,
    disallowedTools: mergeToolLists(
      configuration.disallowedTools,
      child.disallowedTools,
    ),
    maxTurns: child.maxTurns ?? configuration.maxTurns,
    effort: isSupportedEffort(child.effort)
      ? child.effort
      : configuration.effort,
    tools: configuration.tools,
    toolOverrides: configuration.toolOverrides,
    trustedToolOverrides: configuration.trustedToolOverrides,
    // Host overrides/effects are borrowed unchanged by the whole root session
    // tree. Resolved defaults are deliberately not propagated: the child
    // composition rebuilds Memory, Workflow and Jobs for its cwd/session.
    capabilityOverrides: input.capabilityOverrides,
    effects: input.effects,
  };
}

function isSupportedEffort(
  effort: string | undefined,
): effort is NonNullable<OpenHarnessAgentConfiguration["effort"]> {
  return effort === "low" || effort === "medium" || effort === "high";
}

function mergeToolLists(
  inherited: string[] | undefined,
  child: string[] | undefined,
): string[] | undefined {
  const merged = [...(inherited ?? []), ...(child ?? [])];
  return merged.length > 0 ? [...new Set(merged)] : undefined;
}
