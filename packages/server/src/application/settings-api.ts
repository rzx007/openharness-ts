/**
 * Injectable daemon settings / provider surfaces.
 * Kept separate from slash-command registries — clients mutate via resource APIs.
 */

export interface SettingsService {
  get(): Promise<Record<string, unknown>> | Record<string, unknown>;
  patch(
    patch: Record<string, unknown>,
  ):
    | Promise<{ settings: Record<string, unknown>; restartRuntimes?: boolean }>
    | { settings: Record<string, unknown>; restartRuntimes?: boolean };
}

export interface ProviderInfo {
  name: string;
  displayName: string;
  hasKey: boolean;
  active: boolean;
  local?: boolean;
  custom?: boolean;
  requiresApiKey?: boolean;
  source?: "builtin" | "catalog" | "custom" | "subscription";
}

export interface CustomProviderModelInput {
  id: string;
  displayName: string;
  imageInputSupport?: InputSupport;
}

export interface CustomProviderInput {
  id: string;
  displayName: string;
  baseUrl: string;
  apiFormat: "openai";
  apiKey?: string;
  models: CustomProviderModelInput[];
  headers?: Record<string, string>;
}

export interface ProviderService {
  list(): Promise<ProviderInfo[]> | ProviderInfo[];
  create?(input: CustomProviderInput): Promise<ProviderInfo> | ProviderInfo;
  update?(
    id: string,
    input: CustomProviderInput,
  ): Promise<ProviderInfo> | ProviderInfo;
  remove?(id: string): Promise<void> | void;
  connectCatalog?(
    id: string,
    apiKey: string,
  ): Promise<ProviderInfo> | ProviderInfo;
  disconnectCatalog?(id: string): Promise<void> | void;
}

export interface ModelInfo {
  id: string;
  label: string;
  provider: string;
  providerName: string;
  hint?: string;
  contextWindow?: number;
  outputLimit?: number;
  reasoning?: boolean;
  vision?: boolean;
  inputModalities?: string[];
  inputCapabilities?: ModelInputCapabilities;
  toolCalling?: boolean;
  status?: "active" | "beta";
}

export interface ModelProviderInfo {
  name: string;
  displayName: string;
  models: ModelInfo[];
}

export interface ModelService {
  list(): Promise<ModelProviderInfo[]> | ModelProviderInfo[];
}

export interface McpServerStatus {
  name: string;
  status: string;
  toolCount: number;
  resourceCount: number;
  command?: string;
  error?: string;
}

export interface HookInfo {
  id: string;
  event: string;
  type: string;
  enabled: boolean;
  origin: "settings" | "runtime";
}

export interface AuthStatus {
  codex: {
    configured: boolean;
    state: string;
    source: string;
    detail?: string;
    profileLabel?: string;
  };
  storedProviders: string[];
  envProviders: Array<{ name: string; envKey: string }>;
}

export interface AuthService {
  status(): Promise<AuthStatus> | AuthStatus;
  login(input: {
    provider: string;
    apiKey?: string;
  }): Promise<{ message: string }> | { message: string };
  logout(input: {
    provider: string;
  }): Promise<{ message: string }> | { message: string };
}

export interface DreamStartResult {
  started: boolean;
  taskId?: string;
  reason?: string;
  consolidation?: {
    preview: boolean;
    operationCount: number;
    applied: number;
    failed: number;
    backupId?: string;
  };
}

export interface DreamService {
  start(input: {
    cwd: string;
    sessionId?: string;
    preview?: boolean;
  }): Promise<DreamStartResult> | DreamStartResult;
}

export interface AgentIdentityService {
  status(): Promise<{ report: string }> | { report: string };
  init(): Promise<{ report: string }> | { report: string };
}

export interface OutputStyleInfo {
  name: string;
  content: string;
  source: "builtin" | "user";
}

export interface OutputStyleService {
  list(): Promise<OutputStyleInfo[]> | OutputStyleInfo[];
}

export interface ProjectInitService {
  init(input: {
    cwd: string;
  }): Promise<{ report: string }> | { report: string };
}

export interface PluginInfo {
  identity: { id: string; name: string; version: string; displayName?: string };
  origin: "native" | "converted";
  sourceFormat?: string;
  scope: "user" | "project" | "local" | "managed";
  enabled: boolean;
  installation: "installed" | "missing" | "invalid";
  activation: "inactive" | "active" | "partial" | "reload-required";
  toolRuntime?: {
    state: "inactive" | "reload-required" | "starting" | "active" | "degraded" | "error";
    declaredEntries: number;
    activatableEntries: number;
    hostCount: number;
    registeredToolCount: number;
    lastStartedAt?: string;
    lastError?: string;
  };
  inventory: Record<string, number>;
  permissions: { requested: string[]; approved: string[]; missing: string[] };
  diagnostics: Array<{ severity: "info" | "warning" | "error"; phase: string; code: string; message: string; path?: string }>;
}

export interface PluginService {
  list(input: {
    cwd: string;
  }):
    | Promise<{ plugins: PluginInfo[]; warnings: string[] }>
    | { plugins: PluginInfo[]; warnings: string[] };
  setEnabled(input: {
    id: string;
    cwd: string;
    enabled: boolean;
  }):
    | Promise<{ message: string; restartRuntimes?: boolean }>
    | { message: string; restartRuntimes?: boolean };
  installLocal?(input: { cwd: string; sourcePath: string; scope: "user" | "project" | "local"; approvedPermissions: string[]; link?: boolean }): Promise<{ message: string; restartRuntimes?: boolean }>;
  uninstall?(input: { cwd: string; id: string }): Promise<{ message: string; restartRuntimes?: boolean }>;
}

export interface AgentPersonaInfo {
  name: string;
  description: string;
  source?: string;
  model?: string;
}

export interface AgentPersonaService {
  list():
    Promise<{ agents: AgentPersonaInfo[] }> | { agents: AgentPersonaInfo[] };
}

export interface HooksService {
  list(input: {
    cwd: string;
    sessionId?: string;
  }): Promise<{ hooks: HookInfo[] }> | { hooks: HookInfo[] };
}

export interface GitService {
  diff(input: {
    cwd: string;
    full?: boolean;
  }): Promise<{ output: string }> | { output: string };
  branch(input: {
    cwd: string;
    list?: boolean;
  }): Promise<{ output: string }> | { output: string };
  status(input: {
    cwd: string;
  }): Promise<{ output: string }> | { output: string };
  commit(input: {
    cwd: string;
    message: string;
  }): Promise<{ output: string }> | { output: string };
}
import type { InputSupport, ModelInputCapabilities } from "@openharness/core";
