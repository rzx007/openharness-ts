/**
 * Injectable daemon settings / provider surfaces.
 * Kept separate from slash-command registries — clients mutate via resource APIs.
 */

export interface SettingsService {
  get(): Promise<Record<string, unknown>> | Record<string, unknown>;
  patch(
    patch: Record<string, unknown>,
  ): Promise<{ settings: Record<string, unknown>; restartRuntimes?: boolean }>
    | { settings: Record<string, unknown>; restartRuntimes?: boolean };
}

export interface ProviderInfo {
  name: string;
  displayName: string;
  hasKey: boolean;
  active: boolean;
  local?: boolean;
}

export interface ProviderService {
  list(): Promise<ProviderInfo[]> | ProviderInfo[];
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

export interface MemoryEntryRecord {
  id: string;
  content: string;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface MemoryService {
  list(input: { cwd: string }): Promise<{ directory: string; entries: MemoryEntryRecord[] }>
    | { directory: string; entries: MemoryEntryRecord[] };
  get(input: { cwd: string; id: string }): Promise<MemoryEntryRecord | null> | MemoryEntryRecord | null;
  add(input: { cwd: string; content: string; tags?: string[] }): Promise<MemoryEntryRecord> | MemoryEntryRecord;
  remove(input: { cwd: string; id: string }): Promise<boolean> | boolean;
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
  login(input: { provider: string; apiKey?: string }): Promise<{ message: string }> | { message: string };
  logout(input: { provider: string }): Promise<{ message: string }> | { message: string };
}

export interface ContextService {
  preview(input: { cwd: string }): Promise<{ report: string }> | { report: string };
}

export interface DreamStartResult {
  started: boolean;
  taskId?: string;
  reason?: string;
}

export interface DreamService {
  start(input: {
    cwd: string;
    sessionId?: string;
    preview?: boolean;
  }): Promise<DreamStartResult> | DreamStartResult;
}

export interface ProfileService {
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
  init(input: { cwd: string }): Promise<{ report: string }> | { report: string };
}

export interface PluginInfo {
  name: string;
  version: string;
  enabled: boolean;
  skillCount: number;
  commandCount: number;
  hookCount: number;
  agentCount: number;
}

export interface PluginService {
  list(input: { cwd: string }): Promise<{ plugins: PluginInfo[]; warnings: string[] }>
    | { plugins: PluginInfo[]; warnings: string[] };
  setEnabled(input: {
    name: string;
    enabled: boolean;
  }): Promise<{ message: string; restartRuntimes?: boolean }>
    | { message: string; restartRuntimes?: boolean };
}

export interface AgentPersonaInfo {
  name: string;
  description: string;
  source?: string;
  model?: string;
}

export interface AgentPersonaService {
  list(): Promise<{ agents: AgentPersonaInfo[] }> | { agents: AgentPersonaInfo[] };
}

export interface HooksService {
  list(input: { cwd: string; sessionId?: string }): Promise<{ hooks: HookInfo[] }> | { hooks: HookInfo[] };
}

export interface GitService {
  diff(input: { cwd: string; full?: boolean }): Promise<{ output: string }> | { output: string };
  branch(input: { cwd: string; list?: boolean }): Promise<{ output: string }> | { output: string };
  status(input: { cwd: string }): Promise<{ output: string }> | { output: string };
  commit(input: { cwd: string; message: string }): Promise<{ output: string }> | { output: string };
}
