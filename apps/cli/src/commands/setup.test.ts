import { describe, it, expect } from "vitest";
import { buildSetupConfig, createSetupCommand } from "./setup";

describe("buildSetupConfig", () => {
  it("maps an openai_compat provider choice to apiFormat 'openai'", () => {
    const config = buildSetupConfig(
      { providerName: "deepseek", apiKey: "sk-xyz", model: "deepseek-chat" },
      { backendType: "openai_compat" },
    );
    expect(config.settingsPatch).toEqual({
      provider: "deepseek",
      model: "deepseek-chat",
      apiFormat: "openai",
    });
    expect(config.credential).toEqual({
      provider: "deepseek",
      type: "api_key",
      value: "sk-xyz",
    });
  });

  it("maps an anthropic provider choice to apiFormat 'anthropic'", () => {
    const config = buildSetupConfig(
      { providerName: "anthropic", apiKey: "sk-ant", model: "claude-3" },
      { backendType: "anthropic" },
    );
    expect(config.settingsPatch.apiFormat).toBe("anthropic");
    expect(config.settingsPatch.provider).toBe("anthropic");
    expect(config.settingsPatch.model).toBe("claude-3");
  });

  it("omits model from the patch when the model is empty", () => {
    const config = buildSetupConfig(
      { providerName: "openai", apiKey: "k", model: "" },
      { backendType: "openai_compat" },
    );
    expect(config.settingsPatch).not.toHaveProperty("model");
    expect(config.settingsPatch).toEqual({ provider: "openai", apiFormat: "openai" });
  });

  it("trims whitespace-only model to unset", () => {
    const config = buildSetupConfig(
      { providerName: "openai", apiKey: "k", model: "   " },
      { backendType: "openai_compat" },
    );
    expect(config.settingsPatch).not.toHaveProperty("model");
  });

  it("trims surrounding whitespace from a real model name", () => {
    const config = buildSetupConfig(
      { providerName: "openai", apiKey: "k", model: "  gpt-5  " },
      { backendType: "openai_compat" },
    );
    expect(config.settingsPatch.model).toBe("gpt-5");
  });

  it("defaults apiFormat to 'openai' when spec is unknown", () => {
    const config = buildSetupConfig(
      { providerName: "mystery", apiKey: "k", model: "m" },
      undefined,
    );
    expect(config.settingsPatch.apiFormat).toBe("openai");
  });
});

describe("createSetupCommand", () => {
  it("creates a 'setup' command", () => {
    const cmd = createSetupCommand();
    expect(cmd.name()).toBe("setup");
  });
});
