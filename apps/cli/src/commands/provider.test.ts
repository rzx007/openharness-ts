import { describe, it, expect } from "vitest";
import { resolveKeySource, applyProviderConfig, createProviderCommand } from "./provider";
import type { Settings } from "@openharness/core";

function makeSettings(partial: Partial<Settings> = {}): Settings {
  return {
    model: "gpt-4",
    apiFormat: "openai",
    maxTurns: 10,
    permission: { mode: "default" },
    ...partial,
  };
}

describe("resolveKeySource", () => {
  it("returns 'credentials' when provider has stored credentials", () => {
    const source = resolveKeySource(
      "openai",
      ["openai", "anthropic"],
      { OPENAI_API_KEY: "sk-x" },
      { envKey: "OPENAI_API_KEY" }
    );
    expect(source).toBe("credentials");
  });

  it("returns 'env' when no stored credential but envKey is set", () => {
    const source = resolveKeySource(
      "openai",
      ["anthropic"],
      { OPENAI_API_KEY: "sk-x" },
      { envKey: "OPENAI_API_KEY" }
    );
    expect(source).toBe("env");
  });

  it("returns 'none' when neither stored nor env is present", () => {
    const source = resolveKeySource("openai", ["anthropic"], {}, { envKey: "OPENAI_API_KEY" });
    expect(source).toBe("none");
  });

  it("returns 'none' when spec has empty envKey and no stored credential", () => {
    const source = resolveKeySource("ollama", [], { OPENAI_API_KEY: "sk-x" }, { envKey: "" });
    expect(source).toBe("none");
  });

  it("returns 'none' when spec is undefined and no stored credential", () => {
    const source = resolveKeySource("mystery", [], { SOMETHING: "x" });
    expect(source).toBe("none");
  });

  it("prefers 'credentials' over 'env' when both are present", () => {
    const source = resolveKeySource(
      "openai",
      ["openai"],
      { OPENAI_API_KEY: "sk-x" },
      { envKey: "OPENAI_API_KEY" }
    );
    expect(source).toBe("credentials");
  });
});

describe("applyProviderConfig", () => {
  it("sets provider when setActive is true", () => {
    const settings = makeSettings({ provider: "anthropic" });
    const next = applyProviderConfig(settings, { name: "openai", setActive: true });
    expect(next.provider).toBe("openai");
  });

  it("does not set provider when setActive is falsy", () => {
    const settings = makeSettings({ provider: "anthropic" });
    const next = applyProviderConfig(settings, { name: "openai" });
    expect(next.provider).toBe("anthropic");
  });

  it("sets model when provided", () => {
    const settings = makeSettings({ model: "gpt-4" });
    const next = applyProviderConfig(settings, { name: "openai", model: "gpt-5" });
    expect(next.model).toBe("gpt-5");
  });

  it("sets baseUrl when provided", () => {
    const settings = makeSettings();
    const next = applyProviderConfig(settings, { name: "openai", baseUrl: "https://x/v1" });
    expect(next.baseUrl).toBe("https://x/v1");
  });

  it("applies all options together", () => {
    const settings = makeSettings({ provider: "anthropic", model: "old" });
    const next = applyProviderConfig(settings, {
      name: "openrouter",
      model: "new",
      baseUrl: "https://or/v1",
      setActive: true,
    });
    expect(next.provider).toBe("openrouter");
    expect(next.model).toBe("new");
    expect(next.baseUrl).toBe("https://or/v1");
  });

  it("leaves unrelated fields untouched", () => {
    const settings = makeSettings({ model: "keep", baseUrl: "https://keep/v1" });
    const next = applyProviderConfig(settings, { name: "openai", setActive: true });
    expect(next.model).toBe("keep");
    expect(next.baseUrl).toBe("https://keep/v1");
  });

  it("does not mutate the original settings object", () => {
    const settings = makeSettings({ provider: "anthropic", model: "old", baseUrl: "https://old/v1" });
    const snapshot = JSON.stringify(settings);
    applyProviderConfig(settings, {
      name: "openai",
      model: "new",
      baseUrl: "https://new/v1",
      setActive: true,
    });
    expect(JSON.stringify(settings)).toBe(snapshot);
  });
});

describe("createProviderCommand", () => {
  it("registers the 5 expected subcommands", () => {
    const cmd = createProviderCommand();
    const names = cmd.commands.map((c) => c.name()).sort();
    expect(names).toEqual(["add", "edit", "list", "remove", "use"]);
  });
});
