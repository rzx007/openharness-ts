import type { Settings } from "@openharness/core";

import type { SessionRecord } from "./types.js";

export type SessionRuntimeConfig = {
  model: string;
  provider?: string;
  baseUrl?: string;
  apiFormat?: Settings["apiFormat"];
  permissionMode?: "default" | "plan" | "full_auto";
  maxTurns?: number;
  effort?: "low" | "medium" | "high";
  sessionMode?: "direct" | "coordinator";
  systemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
};

export type SessionRuntimeConfigPatch = Partial<SessionRuntimeConfig>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length > 0 ? items : undefined;
}

function permissionModeValue(value: unknown): SessionRuntimeConfig["permissionMode"] | undefined {
  return value === "default" || value === "plan" || value === "full_auto" ? value : undefined;
}

function effortValue(value: unknown): SessionRuntimeConfig["effort"] | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function sessionModeValue(value: unknown): SessionRuntimeConfig["sessionMode"] | undefined {
  return value === "coordinator" ? "coordinator" : value === "direct" ? "direct" : undefined;
}

function apiFormatValue(value: unknown): Settings["apiFormat"] | undefined {
  return value === "anthropic" || value === "openai" ? value : undefined;
}

export function readRuntimeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  return isRecord(metadata?.runtime) ? metadata.runtime : {};
}

/**
 * Read durable session runtime config.
 *
 * Prefer `metadata.runtime.*`, but fall back to the pre-migration layout
 * (`session.model` + top-level metadata fields) so existing daemon stores keep
 * working across the runtime-metadata move.
 */
export function readSessionRuntimeConfig(
  session: SessionRecord,
  defaults?: Partial<SessionRuntimeConfig>,
): SessionRuntimeConfig {
  const runtime = readRuntimeMetadata(session.metadata);
  const legacy = isRecord(session.metadata) ? session.metadata : {};
  const model =
    stringValue(runtime.model) ??
    stringValue(session.model) ??
    stringValue(defaults?.model);
  if (!model) {
    throw new Error(`Session runtime config is missing metadata.runtime.model: ${session.id}`);
  }
  return {
    model,
    ...(stringValue(runtime.provider) ?? defaults?.provider
      ? { provider: stringValue(runtime.provider) ?? defaults?.provider }
      : {}),
    ...(stringValue(runtime.baseUrl) ?? defaults?.baseUrl
      ? { baseUrl: stringValue(runtime.baseUrl) ?? defaults?.baseUrl }
      : {}),
    ...(apiFormatValue(runtime.apiFormat) ?? defaults?.apiFormat
      ? { apiFormat: apiFormatValue(runtime.apiFormat) ?? defaults?.apiFormat }
      : {}),
    ...(permissionModeValue(runtime.permissionMode) ??
    permissionModeValue(legacy.permissionMode) ??
    defaults?.permissionMode
      ? {
          permissionMode:
            permissionModeValue(runtime.permissionMode) ??
            permissionModeValue(legacy.permissionMode) ??
            defaults?.permissionMode,
        }
      : {}),
    ...(numberValue(runtime.maxTurns) ?? numberValue(legacy.maxTurns) ?? defaults?.maxTurns
      ? {
          maxTurns:
            numberValue(runtime.maxTurns) ?? numberValue(legacy.maxTurns) ?? defaults?.maxTurns,
        }
      : {}),
    ...(effortValue(runtime.effort) ?? effortValue(legacy.effort) ?? defaults?.effort
      ? {
          effort: effortValue(runtime.effort) ?? effortValue(legacy.effort) ?? defaults?.effort,
        }
      : {}),
    ...(sessionModeValue(runtime.sessionMode) ??
    sessionModeValue(legacy.sessionMode) ??
    defaults?.sessionMode
      ? {
          sessionMode:
            sessionModeValue(runtime.sessionMode) ??
            sessionModeValue(legacy.sessionMode) ??
            defaults?.sessionMode,
        }
      : {}),
    ...(stringValue(runtime.systemPrompt) ??
    stringValue(legacy.systemPrompt) ??
    defaults?.systemPrompt
      ? {
          systemPrompt:
            stringValue(runtime.systemPrompt) ??
            stringValue(legacy.systemPrompt) ??
            defaults?.systemPrompt,
        }
      : {}),
    ...(stringArrayValue(runtime.allowedTools) ??
    stringArrayValue(legacy.allowedTools) ??
    defaults?.allowedTools
      ? {
          allowedTools:
            stringArrayValue(runtime.allowedTools) ??
            stringArrayValue(legacy.allowedTools) ??
            defaults?.allowedTools,
        }
      : {}),
    ...(stringArrayValue(runtime.disallowedTools) ??
    stringArrayValue(legacy.disallowedTools) ??
    defaults?.disallowedTools
      ? {
          disallowedTools:
            stringArrayValue(runtime.disallowedTools) ??
            stringArrayValue(legacy.disallowedTools) ??
            defaults?.disallowedTools,
        }
      : {}),
  };
}

export function patchSessionRuntimeMetadata(
  metadata: Record<string, unknown>,
  patch: SessionRuntimeConfigPatch,
): Record<string, unknown> {
  const runtime = {
    ...readRuntimeMetadata(metadata),
    ...stripUndefined(patch),
  };
  return {
    ...metadata,
    runtime,
  };
}

export function runtimeMetadataChanged(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  return JSON.stringify(readRuntimeMetadata(before)) !== JSON.stringify(readRuntimeMetadata(after));
}

function stripUndefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}
