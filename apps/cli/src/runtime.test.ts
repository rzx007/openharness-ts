import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { resolveApiKey, computeWorktreeBaseDir, resolveRepoRoot, nodeRunGit, resolveAutoApproveTools, resolveRuntimeModel, formatSandboxUnavailableError, resolveProviderScopedBaseUrl } from "./runtime";
import { LOCAL_READ_ONLY_TOOLS, READ_ONLY_TOOLS } from "@openharness/permissions";
import { CredentialStorage } from "@openharness/auth";
import type { Settings } from "@openharness/core";

const BASE_SETTINGS: Settings = {
  model: "claude-sonnet-4-20250514",
  apiFormat: "anthropic",
  maxTurns: 50,
  permission: { mode: "default" },
};

describe("resolveAutoApproveTools", () => {
  const base = { permission: { mode: "default" } } as Settings;
  const withSettings = {
    permission: { mode: "default", autoApproveTools: ["TodoWrite"] },
  } as Settings;

  it("无任何来源 → undefined(checker 默认行为)", () => {
    expect(resolveAutoApproveTools(base, {})).toBeUndefined();
  });

  it("settings.permission.autoApproveTools 接线(此前被忽略)", () => {
    expect(resolveAutoApproveTools(withSettings, {})).toEqual(["TodoWrite"]);
  });

  it("autoApproveReadOnly 只注入非本地只读工具(channels serve 无头模式)", () => {
    const tools = new Set(resolveAutoApproveTools(base, { autoApproveReadOnly: true }));
    expect(tools.has("Read")).toBe(false);
    expect(tools.has("Glob")).toBe(false);
    expect(tools.has("Grep")).toBe(false);
    expect(tools.has("Lsp")).toBe(false);
    expect(tools.has("TaskList")).toBe(true);
    expect(tools.has("WebFetch")).toBe(true);
    expect(tools.has("Write")).toBe(false);
    expect(tools.has("Bash")).toBe(false);
    expect(tools.size).toBe(READ_ONLY_TOOLS.size - LOCAL_READ_ONLY_TOOLS.size);
  });

  it("overrides.autoApproveTools 显式列表合并(channels serve 收窄集)", () => {
    const tools = new Set(resolveAutoApproveTools(base, { autoApproveTools: ["Read", "Glob"] }));
    expect(tools).toEqual(new Set(["Read", "Glob"]));
  });

  it("settings 显式本地只读授权与 readOnly 合并", () => {
    const tools = new Set(
      resolveAutoApproveTools(
        { permission: { mode: "default", autoApproveTools: ["TodoWrite", "Read"] } } as Settings,
        { autoApproveReadOnly: true },
      ),
    );
    expect(tools.has("TodoWrite")).toBe(true);
    expect(tools.has("Read")).toBe(true);
    expect(tools.size).toBe(READ_ONLY_TOOLS.size - LOCAL_READ_ONLY_TOOLS.size + 2);
  });
});

describe("resolveRuntimeModel", () => {
  it("prefers CLI override model over settings model", () => {
    expect(resolveRuntimeModel(BASE_SETTINGS, { model: "deepseek-v4-flash" })).toBe("deepseek-v4-flash");
  });

  it("falls back to settings model when no override is provided", () => {
    expect(resolveRuntimeModel(BASE_SETTINGS, {})).toBe(BASE_SETTINGS.model);
  });
});

describe("formatSandboxUnavailableError", () => {
  it("formats Docker sandbox startup failures without a stack trace", () => {
    const message = formatSandboxUnavailableError("Docker CLI not found", {
      ...BASE_SETTINGS,
      sandbox: {
        enabled: true,
        backend: "docker",
        failIfUnavailable: true,
      },
    } as Settings);

    expect(message).toContain("Sandbox is enabled, but the docker backend is not available.");
    expect(message).toContain("Reason: Docker CLI not found");
    expect(message).toContain("ohs sandbox doctor");
    expect(message).toContain("ohs sandbox off");
    expect(message).not.toContain("SandboxUnavailableError");
    expect(message).not.toContain(" at ");
  });
});

describe("resolveProviderScopedBaseUrl", () => {
  it("drops a baseUrl that belongs to a different known provider", () => {
    expect(
      resolveProviderScopedBaseUrl("https://open.bigmodel.cn/api/paas/v4", "codex"),
    ).toBeUndefined();
  });

  it("keeps custom baseUrl when it does not identify another provider", () => {
    expect(
      resolveProviderScopedBaseUrl("https://custom.example/v1", "openai"),
    ).toBe("https://custom.example/v1");
  });
});

describe("resolveApiKey", () => {

  let tempDir: string;
  let storage: CredentialStorage;

  const envKeysToClear = [
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY",
    "GEMINI_API_KEY", "DASHSCOPE_API_KEY", "MOONSHOT_API_KEY",
    "GROQ_API_KEY", "MISTRAL_API_KEY", "ZHIPUAI_API_KEY",
    "CODEX_HOME",
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

  it("detects provider from override model when resolving credentials", async () => {
    await storage.storeApiKey("deepseek", "sk-ds-override-model");
    const key = await resolveApiKey(BASE_SETTINGS, { model: "deepseek-v4-flash" }, storage);
    expect(key).toBe("sk-ds-override-model");
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

  it("reads Codex subscription token from CODEX_HOME auth.json", async () => {
    const token = makeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
    });
    writeFileSync(join(tempDir, "auth.json"), JSON.stringify({
      tokens: { access_token: token },
    }));
    process.env.CODEX_HOME = tempDir;
    const key = await resolveApiKey(
      { ...BASE_SETTINGS, provider: "codex", model: "gpt-5.4" },
      undefined,
      storage,
    );
    expect(key).toBe(token);
  });
});

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("computeWorktreeBaseDir", () => {
  it("puts worktrees under <configDir>/worktrees/<repoId>", () => {
    const base = computeWorktreeBaseDir("/home/me/proj", "/cfg");
    expect(base.replace(/\\/g, "/")).toMatch(/^\/cfg\/worktrees\/[0-9a-f]{12}$/);
  });

  it("uses a 12-char sha1 prefix of the normalized repoRoot as repoId", () => {
    const repoRoot = "/home/me/proj";
    const key = process.platform === "win32" ? repoRoot.toLowerCase() : repoRoot;
    const expected = createHash("sha1").update(key).digest("hex").slice(0, 12);
    const base = computeWorktreeBaseDir(repoRoot, "/cfg");
    expect(base.replace(/\\/g, "/")).toBe(`/cfg/worktrees/${expected}`);
  });

  it("is stable across trailing slash and separator differences", () => {
    const a = computeWorktreeBaseDir("/home/me/proj", "/cfg");
    const b = computeWorktreeBaseDir("/home/me/proj/", "/cfg");
    expect(a).toBe(b);
  });

  it("distinguishes different repos", () => {
    const a = computeWorktreeBaseDir("/home/me/proj-a", "/cfg");
    const b = computeWorktreeBaseDir("/home/me/proj-b", "/cfg");
    expect(a).not.toBe(b);
  });
});

describe("nodeRunGit", () => {
  it("returns {code,stdout,stderr} for a successful git command", async () => {
    const { code, stdout } = await nodeRunGit(["--version"], process.cwd());
    expect(code).toBe(0);
    expect(stdout.toLowerCase()).toContain("git version");
  });

  it("returns a non-zero code for an unknown subcommand (no throw)", async () => {
    const { code } = await nodeRunGit(["definitely-not-a-git-command"], process.cwd());
    expect(code).not.toBe(0);
  });
});

describe("resolveRepoRoot", () => {
  it("resolves the git toplevel for a repo cwd", async () => {
    const top = await resolveRepoRoot(process.cwd());
    // 该测试在本仓库内跑：toplevel 必须存在且包含 package.json 不是这里要点，
    // 只断言返回的是一个非空目录（git 的 toplevel 或回退 cwd）。
    expect(typeof top).toBe("string");
    expect(top.length).toBeGreaterThan(0);
  });

  it("falls back to the given cwd when not a git repo", async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), "oh-nonrepo-"));
    try {
      writeFileSync(join(nonRepo, ".git"), "gitdir: ./not-a-real-git-dir\n");
      const top = await resolveRepoRoot(nonRepo);
      expect(top).toBe(nonRepo);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});
