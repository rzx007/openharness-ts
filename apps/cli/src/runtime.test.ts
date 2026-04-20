import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveApiKey } from "./runtime.js";
import { CredentialStorage } from "@openharness/auth";
import type { Settings } from "@openharness/core";

const BASE_SETTINGS: Settings = {
  model: "claude-sonnet-4-20250514",
  apiFormat: "anthropic",
  maxTurns: 50,
  permission: { mode: "default" },
};

describe("resolveApiKey", () => {
  let tempDir: string;
  let storage: CredentialStorage;

  const envKeysToClear = [
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY",
    "GEMINI_API_KEY", "DASHSCOPE_API_KEY", "MOONSHOT_API_KEY",
    "GROQ_API_KEY", "MISTRAL_API_KEY", "ZHIPUAI_API_KEY",
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of envKeysToClear) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    tempDir = mkdtempSync(join(tmpdir(), "oh-test-runtime-"));
    storage = new CredentialStorage(join(tempDir, "credentials.json"));
  });

  afterEach(() => {
    for (const key of envKeysToClear) {
      if (saved[key] !== undefined) process.env[key] = saved[key];
      else delete process.env[key];
    }
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it("returns explicit apiKey from overrides", async () => {
    const key = await resolveApiKey(BASE_SETTINGS, { apiKey: "sk-explicit" }, storage);
    expect(key).toBe("sk-explicit");
  });

  it("returns settings.apiKey when no overrides", async () => {
    const settings = { ...BASE_SETTINGS, apiKey: "sk-settings" };
    const key = await resolveApiKey(settings, undefined, storage);
    expect(key).toBe("sk-settings");
  });

  it("reads from credentialStorage by provider name", async () => {
    await storage.storeApiKey("deepseek", "sk-ds-from-storage");
    const settings = { ...BASE_SETTINGS, provider: "deepseek" };
    const key = await resolveApiKey(settings, undefined, storage);
    expect(key).toBe("sk-ds-from-storage");
  });

  it("reads from credentialStorage by detected provider", async () => {
    await storage.storeApiKey("anthropic", "sk-ant-stored");
    const key = await resolveApiKey(BASE_SETTINGS, undefined, storage);
    expect(key).toBe("sk-ant-stored");
  });

  it("falls back to env var", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-env";
    const key = await resolveApiKey(BASE_SETTINGS, undefined, storage);
    expect(key).toBe("sk-ant-env");
  });

  it("returns empty string when nothing is configured", async () => {
    const key = await resolveApiKey(BASE_SETTINGS, undefined, storage);
    expect(key).toBe("");
  });

  it("prefers explicit override over stored key", async () => {
    await storage.storeApiKey("anthropic", "sk-stored");
    const key = await resolveApiKey(BASE_SETTINGS, { apiKey: "sk-override" }, storage);
    expect(key).toBe("sk-override");
  });

  it("prefers provider-specific storage over env fallback", async () => {
    process.env.OPENAI_API_KEY = "sk-openai-env";
    await storage.storeApiKey("openai", "sk-openai-stored");
    const settings = { ...BASE_SETTINGS, provider: "openai" };
    const key = await resolveApiKey(settings, undefined, storage);
    expect(key).toBe("sk-openai-stored");
  });

  it("does NOT use wrong provider key", async () => {
    await storage.storeApiKey("deepseek", "sk-ds-key");
    const key = await resolveApiKey(BASE_SETTINGS, undefined, storage);
    expect(key).not.toBe("sk-ds-key");
  });
});
