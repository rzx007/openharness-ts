import { describe, expect, it } from "vitest";

import type { Settings } from "@openharness/core";

import { resolveExecutionEnvironmentConfig } from "./execution-config.js";

describe("resolveExecutionEnvironmentConfig", () => {
  it("maps the Desktop Docker choice to fail-closed Docker", () => {
    expect(
      resolveExecutionEnvironmentConfig({
        surface: "desktop_managed",
        settings: settings({
          sandbox: { enabled: true, backend: "docker" },
        }),
        cwd: "D:\\code\\ohs",
      }),
    ).toMatchObject({
      mode: "docker",
      kind: "docker",
      failClosed: true,
    });
  });

  it("rejects SRT and extra mounts on the managed Desktop surface", () => {
    expect(() =>
      resolveExecutionEnvironmentConfig({
        surface: "desktop_managed",
        settings: settings({
          sandbox: { enabled: true, backend: "srt" },
        }),
        cwd: "D:\\code\\ohs",
      }),
    ).toThrow("Desktop does not support the configured SRT environment");

    expect(() =>
      resolveExecutionEnvironmentConfig({
        surface: "desktop_managed",
        settings: settings({
          sandbox: {
            enabled: true,
            backend: "docker",
            docker: { extraMounts: ["C:\\:/host"] },
          },
        }),
        cwd: "D:\\code\\ohs",
      }),
    ).toThrow("Desktop managed Docker does not allow extraMounts");
  });

  it("keeps advanced CLI SRT configuration available", () => {
    expect(
      resolveExecutionEnvironmentConfig({
        surface: "cli_advanced",
        settings: settings({
          sandbox: { enabled: true, backend: "srt" },
        }),
        cwd: "/repo",
      }),
    ).toMatchObject({ mode: "legacy_srt", backend: "srt" });
  });

  it("resolves disabled sandbox as a local environment", () => {
    expect(
      resolveExecutionEnvironmentConfig({
        surface: "desktop_managed",
        settings: settings({ sandbox: { enabled: false } }),
        cwd: "D:\\code\\ohs",
      }),
    ).toMatchObject({ mode: "local", kind: "local", failClosed: false });
  });
});

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    model: "test-model",
    apiFormat: "openai",
    maxTurns: 1,
    permission: { mode: "default" },
    ...overrides,
  };
}
