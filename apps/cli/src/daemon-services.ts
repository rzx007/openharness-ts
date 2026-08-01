import { join } from "node:path";

import { PROVIDERS, findByName } from "@openharness/api";
import { CredentialStorage, describeCodexAuthState } from "@openharness/auth";
import { getProjectMemoryDir, saveSettings, type Settings } from "@openharness/core";
import { MemoryManager, type MemoryEntry } from "@openharness/memory";
import {
  buildPromptLayers,
  initializePersonalPromptFiles,
  inspectPersonalPromptFiles,
} from "@openharness/prompts";
import type {
  AgentPersonaService,
  AuthService,
  ContextService,
  DreamService,
  GitService,
  HooksService,
  MemoryEntryRecord,
  MemoryService,
  OutputStyleService,
  PluginService,
  ProfileService,
  ProjectInitService,
  ProviderService,
  SettingsService,
} from "@openharness/server";
import { getProjectSessionDir, startDreamNow } from "@openharness/services";
import { SkillRegistry } from "@openharness/skills";
import { loadOutputStyles } from "@openharness/output-styles";

import { buildSettingsPatch, coerceConfigValue } from "./config-coerce.js";
import { loadSkillsThreeSources } from "./commands/main.js";
import {
  formatPersonalPromptDiagnostics,
  formatPromptLayersReport,
} from "./commands/slash-helpers.js";
import { resolveProviderScopedBaseUrl } from "./runtime.js";

export interface MutableSettingsRef {
  current: Settings;
}

function sanitizeSettings(settings: Settings): Record<string, unknown> {
  const { apiKey: _apiKey, ...rest } = settings as Settings & { apiKey?: string };
  return structuredClone(rest) as Record<string, unknown>;
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
  } as Settings;
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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

export function createCliSettingsService(ref: MutableSettingsRef): SettingsService {
  return {
    get() {
      return sanitizeSettings(ref.current);
    },
    async patch(patch) {
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

export function createCliProviderService(ref: MutableSettingsRef): ProviderService {
  const storage = new CredentialStorage();
  return {
    async list() {
      const currentName = ref.current.provider ?? "auto";
      const rows = [];
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

export function describeProviderSwitch(providerName: string): {
  patch: Record<string, unknown>;
  label: string;
} {
  if (providerName === "auto") {
    return { patch: { provider: "auto" }, label: "auto-detect" };
  }
  const spec = findByName(providerName);
  const patch: Record<string, unknown> = { provider: providerName };
  if (providerName === "codex") patch.model = "gpt-5.4";
  return {
    patch,
    label: `${spec?.displayName ?? providerName}${patch.model ? ` (model: ${patch.model})` : ""}`,
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

export function createCliMemoryService(): MemoryService {
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

export function createCliAuthService(): AuthService {
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

export function createCliContextService(ref: MutableSettingsRef): ContextService {
  return {
    async preview({ cwd }) {
      const settings = ref.current;
      const { manager } = await openMemoryManager(cwd);
      const memoryContent =
        settings.memory?.enabled !== false
          ? manager.buildMemoryPrompt(settings.memory?.maxFiles ?? 10)
          : undefined;
      const skillRegistry = new SkillRegistry();
      await loadSkillsThreeSources(skillRegistry, cwd, settings);
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
  };
}

export function createCliDreamService(ref: MutableSettingsRef): DreamService {
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

export function createCliProfileService(): ProfileService {
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

export function createCliOutputStyleService(): OutputStyleService {
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

export function createCliProjectInitService(): ProjectInitService {
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

export function createCliPluginService(ref: MutableSettingsRef): PluginService {
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

export function createCliAgentPersonaService(): AgentPersonaService {
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

export function createCliHooksService(ref: MutableSettingsRef): HooksService {
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

export function createCliGitService(): GitService {
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
