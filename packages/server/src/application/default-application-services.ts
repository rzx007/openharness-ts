import { access } from "node:fs/promises";
import { join } from "node:path";

import {
  PROVIDERS,
  createModelCatalogService,
  findByName,
  resolveProviderScopedBaseUrl,
  type ModelsDevCatalog,
  type ModelsDevModel,
} from "@openharness/api";
import { CredentialStorage, describeCodexAuthState } from "@openharness/auth";
import {
  getProjectMemoryDir,
  getCredentialsFilePath,
  getConfigDir,
  saveSettings,
  type Settings,
} from "@openharness/core";
import { MemoryManager, type MemoryEntry } from "@openharness/memory";
import {
  buildPromptLayers,
  discoverClaudeMdFiles,
  initializePersonalPromptFiles,
  inspectPersonalPromptFiles,
  listPendingUserProfileUpdates,
  renderPromptLayers,
  type PersonalPromptFileDiagnostic,
  type PromptLayers,
} from "@openharness/prompts";
import { getLocalRulesDir, loadFacts, loadLocalRules } from "@openharness/personalization";
import { getProjectSessionDir, startDreamNow } from "@openharness/services";
import { loadOutputStyles } from "@openharness/output-styles";
import {
  discoverOpenHarnessExtensions,
} from "@openharness/agent-runtime";

import type {
  AgentPersonaService,
  AuthService,
  ContextService,
  DreamService,
  GitService,
  HooksService,
  MemoryEntryRecord,
  MemoryService,
  ModelInfo,
  ModelProviderInfo,
  ModelService,
  OutputStyleService,
  PluginService,
  ProfileService,
  ProjectInitService,
  ProviderInfo,
  ProviderService,
  SettingsService,
} from "./settings-api.js";

export interface DaemonSettingsRef {
  current: Settings;
  reload?: () => Promise<Settings> | Settings;
}

function sanitizeSettings(settings: Settings): Record<string, unknown> {
  const { apiKey: _apiKey, ...rest } = settings as Settings & { apiKey?: string };
  return structuredClone(rest) as Record<string, unknown>;
}

async function readCurrentSettings(ref: DaemonSettingsRef): Promise<Settings> {
  const loaded = ref.reload ? await ref.reload() : undefined;
  if (loaded) ref.current = loaded;
  return ref.current;
}

function mergeSettingsPatch(current: Settings, patch: Record<string, unknown>): Settings {
  const next: Settings = {
    ...current,
    ...patch,
    permission: {
      ...current.permission,
      ...(isRecord(patch.permission) ? patch.permission : {}),
    },
    memory: {
      ...current.memory,
      ...(isRecord(patch.memory) ? patch.memory : {}),
    },
    sandbox: {
      ...current.sandbox,
      ...(isRecord(patch.sandbox) ? patch.sandbox : {}),
    },
    daemon: {
      ...current.daemon,
      ...(isRecord(patch.daemon) ? patch.daemon : {}),
    },
  } as Settings;
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function coerceConfigValue(key: string, value: string): unknown {
  if (["model", "apiFormat", "baseUrl", "systemPrompt", "theme", "outputStyle", "effort", "provider"].includes(key)) {
    return value;
  }
  if (["maxTurns", "maxTokens", "passes"].includes(key)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if ([
    "verbose",
    "vimMode",
    "voiceMode",
    "fastMode",
    "memory.enabled",
    "memory.sessionMemoryEnabled",
    "memory.autoExtractEnabled",
    "memory.autoDreamEnabled",
    "daemon.autoStart",
  ].includes(key)) {
    if (value === "true" || value === "on") return true;
    if (value === "false" || value === "off") return false;
    return undefined;
  }
  if ([
    "memory.maxFiles",
    "memory.maxEntrypointLines",
    "memory.autoExtractMaxRecords",
    "memory.autoDreamMinHours",
    "memory.autoDreamMinSessions",
  ].includes(key)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (key === "permission.mode") {
    return ["default", "plan", "full_auto"].includes(value) ? value : undefined;
  }
  return value;
}

function buildSettingsPatch(
  settings: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const [head, child] = key.split(".");
  if (!head || !child) return { [key]: value };
  const current = isRecord(settings[head]) ? settings[head] : {};
  return { [head]: { ...current, [child]: value } };
}

function formatPersonalPromptDiagnostics(diagnostics: PersonalPromptFileDiagnostic[]): string {
  const lines = ["Personal prompt files:"];
  for (const item of diagnostics) {
    const flags = [
      item.truncated ? "truncated" : "",
      item.issues.length > 0 ? `${item.issues.length} issue(s)` : "",
    ].filter(Boolean);
    lines.push(`- ${item.file}: ${item.status}${flags.length ? ` (${flags.join(", ")})` : ""}`);
    lines.push(`  path: ${item.path}`);
    if (item.message) lines.push(`  note: ${item.message}`);
    for (const issue of item.issues) {
      lines.push(`  ${issue.severity}: ${issue.code} - ${issue.message}`);
    }
  }
  return lines.join("\n");
}

function formatPromptLayersReport(
  layers: PromptLayers,
  previewChars: number,
  diagnostics: PersonalPromptFileDiagnostic[],
): string {
  const sectionPreviewChars = 350;
  const prompt = renderPromptLayers(layers);
  const preview = prompt.length > previewChars
    ? `${prompt.slice(0, previewChars)}\n... (truncated)`
    : prompt;
  const section = (name: keyof PromptLayers) => {
    const values = layers[name].filter((value) => value.trim());
    if (values.length === 0) return `[${name}]\n(empty)`;
    const previews = values.map((value, index) => {
      const trimmed = value.trim();
      const text = trimmed.length > sectionPreviewChars
        ? `${trimmed.slice(0, sectionPreviewChars)}\n... (truncated)`
        : trimmed;
      return `section ${index + 1}:\n${text}`;
    });
    return `[${name}]\n${previews.join("\n\n")}`;
  };
  const divider = "-".repeat(60);
  return [
    "Current system prompt layers:",
    `- stable: ${layers.stable.length} section(s), ${layerCharCount(layers.stable)} characters`,
    `- context: ${layers.context.length} section(s), ${layerCharCount(layers.context)} characters`,
    `- volatile: ${layers.volatile.length} section(s), ${layerCharCount(layers.volatile)} characters`,
    divider,
    section("stable"),
    divider,
    section("context"),
    divider,
    section("volatile"),
    divider,
    "Flat preview:",
    preview,
    ...(diagnostics.length > 0 ? [divider, formatPersonalPromptDiagnostics(diagnostics)] : []),
    divider,
    `Total length: ${prompt.length} characters`,
  ].join("\n");
}

function layerCharCount(parts: string[]): number {
  return parts.filter((part) => part.trim()).join("\n\n").length;
}

interface ContextStatusRow {
  source: string;
  status: string;
  written: string;
  injected: string;
  purpose: string;
}

function formatContextStatusTable(rows: ContextStatusRow[]): string {
  const headers = ["Source", "Status", "Written", "Injected / read", "Purpose"];
  const body = rows.map((row) => [row.source, row.status, row.written, row.injected, row.purpose]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...body.map((row) => row[index]!.length)));
  const formatRow = (cells: string[]) =>
    `| ${cells.map((cell, index) => cell.padEnd(widths[index]!)).join(" | ")} |`;
  return [
    formatRow(headers),
    formatRow(widths.map((width) => "-".repeat(width))),
    ...body.map(formatRow),
  ].join("\n");
}

function diagnosticStatus(diagnostics: PersonalPromptFileDiagnostic[], file: "SOUL.md" | "USER.md"): string {
  const item = diagnostics.find((diagnostic) => diagnostic.file === file);
  if (!item) return "unknown";
  const flags = [
    item.truncated ? "truncated" : "",
    item.issues.length ? `${item.issues.length} issue(s)` : "",
  ].filter(Boolean);
  return flags.length ? `${item.status} (${flags.join(", ")})` : item.status;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const RUNTIME_RESTART_KEYS = new Set([
  "provider",
  "baseUrl",
  "apiFormat",
  "apiKey",
  "mcpServers",
  "plugins",
  "allowProjectPlugins",
  "maxTurns",
  "effort",
  "fastMode",
]);

export function createDefaultSettingsService(ref: DaemonSettingsRef): SettingsService {
  return {
    async get() {
      return sanitizeSettings(await readCurrentSettings(ref));
    },
    async patch(patch) {
      await readCurrentSettings(ref);
      let effectivePatch = patch;
      if (typeof patch.path === "string" && "value" in patch) {
        const coerced = coerceConfigValue(patch.path, String(patch.value));
        if (coerced === undefined) throw new Error(`Unknown or invalid config key/value: ${patch.path}`);
        effectivePatch = buildSettingsPatch(
          sanitizeSettings(ref.current),
          patch.path,
          coerced,
        );
      }

      const next = mergeSettingsPatch(ref.current, effectivePatch);
      if (typeof effectivePatch.provider === "string") {
        next.provider = effectivePatch.provider;
        next.baseUrl = resolveProviderScopedBaseUrl(next.baseUrl, effectivePatch.provider);
        if (effectivePatch.provider === "codex" && !effectivePatch.model) next.model = "gpt-5.4";
      }
      if (effectivePatch.provider === "auto") {
        delete next.provider;
      }
      await saveSettings(next);
      ref.current = next;
      const restartRuntimes = Object.keys(effectivePatch).some((key) => RUNTIME_RESTART_KEYS.has(key));
      return { settings: sanitizeSettings(next), restartRuntimes };
    },
  };
}

export function createDefaultProviderService(ref: DaemonSettingsRef): ProviderService {
  const storage = new CredentialStorage();
  return {
    async list() {
      const current = await readCurrentSettings(ref);
      const currentName = current.provider ?? "auto";
      const rows: ProviderInfo[] = [];
      for (const spec of PROVIDERS) {
        const storedKey = await storage.loadApiKey(spec.name);
        const hasKey = !!storedKey || (spec.envKey ? !!process.env[spec.envKey] : false);
        rows.push({
          name: spec.name,
          displayName: spec.displayName,
          hasKey: !!hasKey || !spec.envKey,
          active: spec.name === currentName,
          local: !spec.envKey,
        });
      }
      return rows;
    },
  };
}

const CATALOG_PROVIDER_ALIASES: Record<string, string[]> = {
  bedrock: ["amazon-bedrock"],
  codex: ["codex", "opencode"],
  dashscope: ["dashscope", "alibaba"],
  gemini: ["gemini", "google"],
  vertex: ["google-vertex", "vertex"],
  zhipu: ["zhipu", "z-ai"],
};

function catalogProviderKeys(providerName: string): string[] {
  return [providerName, ...(CATALOG_PROVIDER_ALIASES[providerName] ?? [])]
    .filter((item, index, items) => item && items.indexOf(item) === index);
}

function readCatalogProvider(catalog: ModelsDevCatalog, providerName: string) {
  for (const key of catalogProviderKeys(providerName)) {
    const provider = catalog[key];
    if (provider?.models && Object.keys(provider.models).length > 0) return provider;
  }
  return undefined;
}

function modelHint(model: ModelsDevModel): string | undefined {
  const cost = model.cost;
  if (cost && cost.input === 0 && cost.output === 0) return "Free";
  return undefined;
}

function modelVision(model: ModelsDevModel): boolean | undefined {
  const input = model.modalities?.input;
  if (!input) return undefined;
  return input.includes("image") || input.includes("pdf") || input.includes("video");
}

function toModelInfo(providerName: string, providerDisplayName: string, id: string, model: ModelsDevModel): ModelInfo {
  return {
    id,
    label: model.name ?? model.id ?? id,
    provider: providerDisplayName,
    providerName,
    ...(modelHint(model) ? { hint: modelHint(model) } : {}),
    ...(typeof model.limit?.context === "number" ? { contextWindow: model.limit.context } : {}),
    ...(typeof model.limit?.output === "number" ? { outputLimit: model.limit.output } : {}),
    ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
    ...(typeof modelVision(model) === "boolean" ? { vision: modelVision(model) } : {}),
    ...(typeof model.tool_call === "boolean" ? { toolCalling: model.tool_call } : {}),
    ...(model.status === "beta" ? { status: "beta" as const } : { status: "active" as const }),
  };
}

async function isProviderConnected(providerName: string, storage: CredentialStorage): Promise<boolean> {
  const spec = findByName(providerName);
  if (!spec) return false;
  if (spec.isLocal) return true;
  if (providerName === "codex") return (await describeCodexAuthState()).configured;
  if (await storage.loadApiKey(providerName)) return true;
  return !!(spec.envKey && process.env[spec.envKey]);
}

export function createDefaultModelService(): ModelService {
  const storage = new CredentialStorage();
  const catalogService = createModelCatalogService();
  return {
    async list(): Promise<ModelProviderInfo[]> {
      const catalog = await catalogService.load();
      const result: ModelProviderInfo[] = [];

      for (const spec of PROVIDERS) {
        if (!await isProviderConnected(spec.name, storage)) continue;
        const catalogProvider = readCatalogProvider(catalog, spec.name);
        if (!catalogProvider?.models) continue;

        const models = Object.entries(catalogProvider.models)
          .filter(([, model]) => model.status !== "deprecated" && model.status !== "alpha")
          .map(([id, model]) => toModelInfo(spec.name, spec.displayName, model.id ?? id, model));
        if (models.length === 0) continue;

        result.push({
          name: spec.name,
          displayName: spec.displayName,
          models,
        });
      }

      return result;
    },
  };
}

function toMemoryRecord(entry: MemoryEntry): MemoryEntryRecord {
  return {
    id: entry.id,
    content: entry.content,
    ...(entry.tags ? { tags: [...entry.tags] } : {}),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

async function openMemoryManager(cwd: string): Promise<{ manager: MemoryManager; directory: string }> {
  const directory = getProjectMemoryDir(cwd);
  const manager = new MemoryManager(1000, directory);
  await manager.loadFromFile(join(directory, "memory.json")).catch(() => {});
  return { manager, directory };
}

export function createDefaultMemoryService(): MemoryService {
  return {
    async list({ cwd }) {
      const { manager, directory } = await openMemoryManager(cwd);
      const entries = await manager.getAll();
      return { directory, entries: entries.map(toMemoryRecord) };
    },
    async get({ cwd, id }) {
      const { manager } = await openMemoryManager(cwd);
      const entry = await manager.get(id);
      return entry ? toMemoryRecord(entry) : null;
    },
    async add({ cwd, content, tags }) {
      const { manager } = await openMemoryManager(cwd);
      const entry = await manager.add(content, tags);
      return toMemoryRecord(entry);
    },
    async remove({ cwd, id }) {
      const { manager } = await openMemoryManager(cwd);
      return await manager.delete(id);
    },
  };
}

function normalizeAuthProvider(target?: string): string | undefined {
  const normalized = target?.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return undefined;
  if (
    normalized === "codex" ||
    normalized === "openai-codex" ||
    normalized === "codex-subscription"
  ) {
    return "codex";
  }
  return normalized;
}

export function createDefaultAuthService(): AuthService {
  const storage = new CredentialStorage();
  return {
    async status() {
      const providers = await storage.listStoredProviders();
      const codexState = await describeCodexAuthState();
      const envProviders: Array<{ name: string; envKey: string }> = [];
      for (const spec of PROVIDERS) {
        if (spec.envKey && process.env[spec.envKey]) {
          envProviders.push({ name: spec.name, envKey: spec.envKey });
        }
      }
      return {
        codex: {
          configured: codexState.configured,
          state: codexState.state,
          source: codexState.source,
          ...(codexState.detail ? { detail: codexState.detail } : {}),
          ...(codexState.profileLabel ? { profileLabel: codexState.profileLabel } : {}),
        },
        storedProviders: providers,
        envProviders,
      };
    },
    async login({ provider, apiKey }) {
      const providerName = normalizeAuthProvider(provider);
      if (!providerName) throw new Error("Usage: /auth login <provider> <api-key> or /auth login codex");
      if (providerName === "codex") {
        const state = await describeCodexAuthState();
        if (!state.configured) {
          throw new Error(`Codex Subscription ${state.state}: ${state.detail ?? state.source}`);
        }
        return {
          message: `Codex Subscription ready${state.profileLabel ? ` (${state.profileLabel})` : ""}. Use /provider codex to switch.`,
        };
      }
      if (!apiKey) throw new Error("Usage: /auth login <provider> <api-key>");
      const spec = findByName(providerName);
      if (!spec) throw new Error(`Unknown provider: ${providerName}. Use /provider to see available providers.`);
      await storage.storeApiKey(providerName, apiKey);
      return { message: `API key stored for ${spec.displayName} (${spec.name}).` };
    },
    async logout({ provider }) {
      const providerName = normalizeAuthProvider(provider) ?? provider.trim();
      if (!providerName) throw new Error("Usage: /auth logout <provider>");
      await storage.clearProviderCredentials(providerName);
      const suffix = providerName === "codex" ? " Codex CLI auth.json was not removed." : "";
      return { message: `Credentials cleared for ${providerName}.${suffix}` };
    },
  };
}

export function createDefaultContextService(ref: DaemonSettingsRef): ContextService {
  return {
    async preview({ cwd }) {
      const settings = await readCurrentSettings(ref);
      const { manager } = await openMemoryManager(cwd);
      const memoryContent =
        settings.memory?.enabled !== false
          ? manager.buildMemoryPrompt(settings.memory?.maxFiles ?? 10)
          : undefined;
      const { skillRegistry } = await discoverOpenHarnessExtensions(cwd, settings);
      const layers = await buildPromptLayers({
        customPrompt: settings.systemPrompt,
        cwd,
        permissionMode: settings.permission.mode,
        fastMode: settings.fastMode,
        effort: settings.effort,
        passes: settings.passes,
        memoryContent,
        skillsList: skillRegistry.modelVisibleList(),
      });
      const diagnostics = await inspectPersonalPromptFiles();
      return { report: formatPromptLayersReport(layers, 2_000, diagnostics) };
    },
    async status({ cwd }) {
      const settings = await readCurrentSettings(ref);
      const diagnostics = await inspectPersonalPromptFiles();
      const pendingUserUpdates = await listPendingUserProfileUpdates();
      const projectInstructionFiles = await discoverClaudeMdFiles(cwd);
      const { manager, directory: memoryDirectory } = await openMemoryManager(cwd);
      const memoryEntries = await manager.getAll();
      const { skillRegistry } = await discoverOpenHarnessExtensions(cwd, settings);
      const localRules = loadLocalRules();
      const facts = loadFacts();
      const credentialsPath = getCredentialsFilePath();
      const credentialsConfigured = await pathExists(credentialsPath);
      const outputStyles = loadOutputStyles();

      const rows: ContextStatusRow[] = [
        {
          source: "SOUL.md",
          status: diagnosticStatus(diagnostics, "SOUL.md"),
          written: "/profile init or manual edit",
          injected: "system prompt stable identity",
          purpose: "agent identity and tone",
        },
        {
          source: "USER.md",
          status: diagnosticStatus(diagnostics, "USER.md"),
          written: "/profile init, manual edit, approved pending update",
          injected: "system prompt volatile User Profile",
          purpose: "user long-term preferences",
        },
        {
          source: "USER pending",
          status: `${pendingUserUpdates.length} pending`,
          written: "queueUserProfileUpdate()",
          injected: "not injected until approved",
          purpose: "review boundary for USER.md changes",
        },
        {
          source: "local_rules",
          status: localRules ? `${facts.facts.length} fact(s)` : "missing",
          written: "/remember success best-effort",
          injected: "system prompt volatile local rules",
          purpose: "machine environment facts",
        },
        {
          source: "Project Instructions",
          status: `${projectInstructionFiles.length} file(s)`,
          written: "manual project files",
          injected: "system prompt context Project Instructions",
          purpose: "repo rules and workflows",
        },
        {
          source: "settings.systemPrompt",
          status: settings.systemPrompt?.trim() ? "set" : "empty",
          written: "/config, CLI args, session runtime metadata",
          injected: "system prompt context Custom Instructions",
          purpose: "extra user-configured instructions",
        },
        {
          source: "Environment",
          status: "dynamic",
          written: "computed per prompt build",
          injected: "system prompt stable Environment",
          purpose: "cwd, OS, git, shell facts",
        },
        {
          source: "Runtime modes",
          status: `permission=${settings.permission.mode}, fast=${settings.fastMode ? "on" : "off"}, effort=${settings.effort ?? "medium"}`,
          written: "settings or session runtime metadata",
          injected: "system prompt stable runtime sections",
          purpose: "execution policy and reasoning knobs",
        },
        {
          source: "Available Skills",
          status: `${skillRegistry.modelVisibleList().length} visible`,
          written: "skill/plugin discovery",
          injected: "system prompt stable Available Skills",
          purpose: "model-visible extension catalog",
        },
        {
          source: "Project Memory",
          status: `${memoryEntries.length} entr${memoryEntries.length === 1 ? "y" : "ies"}`,
          written: "/memory, /remember, auto extract",
          injected: "per-turn system-reminder; preview may show full prompt",
          purpose: "project durable semantic facts",
        },
        {
          source: "Session Memory",
          status: "per-session checkpoint",
          written: "after each successful turn",
          injected: "compact/autocompact summary prompt only",
          purpose: "conversation continuity after compact",
        },
        {
          source: "Session History",
          status: "daemon runtime store",
          written: "session events/messages/runs/tasks",
          injected: "/sessions, /resume, daemon recovery",
          purpose: "restore conversation state",
        },
        {
          source: "Output styles",
          status: `${outputStyles.length} style(s)`,
          written: "manual files",
          injected: "output style selection service",
          purpose: "presentation style",
        },
        {
          source: "Credentials",
          status: credentialsConfigured ? "configured" : "missing",
          written: "/auth login or provider setup",
          injected: "provider/auth resolution only",
          purpose: "API keys; never prompt context",
        },
      ];

      return {
        report: [
          "Context status:",
          `cwd: ${cwd}`,
          `config: ${getConfigDir()}`,
          `local_rules: ${getLocalRulesDir()}`,
          `project_memory: ${memoryDirectory}`,
          "",
          formatContextStatusTable(rows),
        ].join("\n"),
      };
    },
  };
}

export function createDefaultDreamService(ref: DaemonSettingsRef): DreamService {
  return {
    async start({ cwd, sessionId, preview }) {
      const { manager, directory } = await openMemoryManager(cwd);
      const stale = await manager.findStaleCandidates();
      const staleSection = stale
        .slice(0, 20)
        .map((entry) =>
          `- ${entry.id}: ${entry.id}.md (importance=${entry.importance ?? 0}, updated_at=${new Date(entry.updatedAt).toISOString().slice(0, 10)})`,
        )
        .join("\n");
      const settings = {
        ...ref.current,
        memory: { enabled: true, ...ref.current.memory },
      };
      const task = await startDreamNow({
        cwd,
        settings,
        memoryDir: directory,
        sessionDir: getProjectSessionDir(cwd),
        force: true,
        preview: preview === true,
        currentSessionId: sessionId,
        staleSection,
      });
      if (!task) {
        return {
          started: false,
          reason: "Dream was not started: consolidation lock held, disabled, or inside a dream subprocess",
        };
      }
      return { started: true, taskId: task.id };
    },
  };
}

export function createDefaultProfileService(): ProfileService {
  return {
    async status() {
      const diagnostics = await inspectPersonalPromptFiles();
      return { report: formatPersonalPromptDiagnostics(diagnostics) };
    },
    async init() {
      const result = await initializePersonalPromptFiles();
      const diagnostics = await inspectPersonalPromptFiles();
      const lines = [
        `Personal prompt directory: ${result.configDir}`,
        `Created: ${result.created.length}`,
        ...result.created.map((path) => `  + ${path}`),
        `Skipped existing: ${result.skipped.length}`,
        ...result.skipped.map((path) => `  = ${path}`),
        "",
        formatPersonalPromptDiagnostics(diagnostics),
      ];
      return { report: lines.join("\n") };
    },
  };
}

export function createDefaultOutputStyleService(): OutputStyleService {
  return {
    list() {
      return loadOutputStyles().map((style) => ({
        name: style.name,
        content: style.content,
        source: style.source,
      }));
    },
  };
}

export function createDefaultProjectInitService(): ProjectInitService {
  return {
    async init({ cwd }) {
      const { writeFile, mkdir, access } = await import("node:fs/promises");
      const files: Array<{ path: string; content: string; label: string }> = [
        {
          path: join(cwd, "CLAUDE.md"),
          content: `# Project Rules\n\nAdd your project-specific rules and instructions here.\n`,
          label: "CLAUDE.md",
        },
        {
          path: join(cwd, ".openharness", "README.md"),
          content: `# OpenHarness Config\n\nThis directory contains OpenHarness project configuration.\n`,
          label: ".openharness/README.md",
        },
        {
          path: join(cwd, ".openharness", "memory", "MEMORY.md"),
          content: `# Memory\n\nThis file stores project memory for the AI assistant.\n`,
          label: ".openharness/memory/MEMORY.md",
        },
      ];
      const dirs = [
        join(cwd, ".openharness"),
        join(cwd, ".openharness", "memory"),
        join(cwd, ".openharness", "plugins"),
        join(cwd, ".openharness", "skills"),
      ];
      const lines: string[] = ["Initializing OpenHarness project...", ""];
      for (const dir of dirs) {
        await mkdir(dir, { recursive: true });
      }
      lines.push("  Created directories.");
      for (const file of files) {
        try {
          await access(file.path);
          lines.push(`  Skipped ${file.label} (already exists)`);
        } catch {
          await writeFile(file.path, file.content, "utf-8");
          lines.push(`  Created ${file.label}`);
        }
      }
      lines.push("", "Project initialized successfully.");
      return { report: lines.join("\n") };
    },
  };
}

export function createDefaultPluginService(ref: DaemonSettingsRef): PluginService {
  return {
    async list({ cwd }) {
      const { loadPlugins } = await import("@openharness/plugins");
      const { plugins, warnings } = await loadPlugins(ref.current, cwd);
      return {
        plugins: plugins.map((plugin) => ({
          name: plugin.manifest.name,
          version: plugin.manifest.version,
          enabled: plugin.enabled,
          skillCount: plugin.skills.length,
          commandCount: plugin.commands.length,
          hookCount: plugin.hooks.length,
          agentCount: plugin.agents.length,
        })),
        warnings,
      };
    },
    async setEnabled({ name, enabled }) {
      const next = {
        ...ref.current,
        plugins: { ...(ref.current.plugins ?? {}), [name]: enabled },
      };
      await saveSettings(next);
      ref.current = next;
      return {
        message: `${enabled ? "Enabled" : "Disabled"} plugin '${name}'. Use /reload-plugins to rediscover immediately, or wait for next runtime warm.`,
        restartRuntimes: true,
      };
    },
  };
}

export function createDefaultAgentPersonaService(): AgentPersonaService {
  return {
    async list() {
      const { getAllAgentDefinitions } = await import("@openharness/coordinator");
      const agents = getAllAgentDefinitions();
      return {
        agents: agents.map((agent) => ({
          name: agent.name,
          description: agent.description,
          ...(agent.source ? { source: agent.source } : {}),
          ...(agent.model ? { model: agent.model } : {}),
        })),
      };
    },
  };
}

export function createDefaultHooksService(ref: DaemonSettingsRef): HooksService {
  return {
    list({ cwd: _cwd }) {
      const settingsHooks = ref.current.hooks ?? [];
      return {
        hooks: settingsHooks.map((hook) => ({
          id: hook.id,
          event: hook.event,
          type: hook.type,
          enabled: hook.enabled !== false,
          origin: "settings" as const,
        })),
      };
    },
  };
}

export function createDefaultGitService(): GitService {
  return {
    async diff({ cwd, full }) {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(execFile);
      try {
        if (full) {
          const { stdout } = await execAsync("git", ["diff", "HEAD"], {
            cwd,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
          });
          return { output: stdout || "(no diff)" };
        }
        const { stdout } = await execAsync("git", ["diff", "--stat"], { cwd, windowsHide: true });
        return { output: stdout || "(no changes)" };
      } catch (error) {
        throw new Error(`git diff failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async branch({ cwd, list }) {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(execFile);
      try {
        if (list) {
          const { stdout } = await execAsync("git", ["branch", "-a"], { cwd, windowsHide: true });
          return { output: stdout || "(no branches)" };
        }
        const { stdout } = await execAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd,
          windowsHide: true,
        });
        return { output: `Current branch: ${stdout.trim()}` };
      } catch (error) {
        throw new Error(`git branch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async status({ cwd }) {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(execFile);
      try {
        const { stdout } = await execAsync("git", ["status", "--short"], { cwd, windowsHide: true });
        return { output: stdout || "(working tree clean)" };
      } catch (error) {
        throw new Error(`git status failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async commit({ cwd, message }) {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(execFile);
      try {
        await execAsync("git", ["add", "-A"], { cwd, windowsHide: true });
        const { stdout } = await execAsync("git", ["commit", "-m", message], { cwd, windowsHide: true });
        return { output: stdout.trim() || "Committed." };
      } catch (error) {
        throw new Error(`git commit failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

/** Complete resource-service set installed by the opinionated daemon application. */
export function createDefaultApplicationServices(ref: DaemonSettingsRef) {
  return {
    settings: createDefaultSettingsService(ref),
    provider: createDefaultProviderService(ref),
    model: createDefaultModelService(),
    memory: createDefaultMemoryService(),
    auth: createDefaultAuthService(),
    context: createDefaultContextService(ref),
    dream: createDefaultDreamService(ref),
    profile: createDefaultProfileService(),
    outputStyle: createDefaultOutputStyleService(),
    projectInit: createDefaultProjectInitService(),
    plugin: createDefaultPluginService(ref),
    agentPersona: createDefaultAgentPersonaService(),
    hooks: createDefaultHooksService(ref),
    git: createDefaultGitService(),
  };
}
