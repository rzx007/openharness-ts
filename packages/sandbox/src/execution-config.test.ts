import { describe, expect, it } from "vitest";
import { resolveExecutionEnvironmentConfig } from "./execution-config.js";

const settings = (kind: "native" | "wsl", sandbox = { enabled: false }) => ({
  model: "test", apiFormat: "openai" as const, maxTurns: 1, permission: { mode: "default" as const },
  agentEnvironment: { kind }, sandbox,
});

describe("resolveExecutionEnvironmentConfig", () => {
  it("maps Native to local and WSL to wsl", () => {
    expect(resolveExecutionEnvironmentConfig({ surface: "desktop_managed", settings: settings("native"), cwd: "D:\\repo" })).toMatchObject({ kind: "local" });
    expect(resolveExecutionEnvironmentConfig({ surface: "desktop_managed", settings: settings("wsl"), cwd: "D:\\repo" })).toMatchObject({ kind: "wsl" });
  });
  it("rejects the currently unsupported WSL plus SRT combination", () => {
    expect(() => resolveExecutionEnvironmentConfig({ surface: "desktop_managed", settings: settings("wsl", { enabled: true }), cwd: "D:\\repo" })).toThrow("cannot currently be combined");
  });
});
