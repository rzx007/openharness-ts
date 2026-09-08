import { describe, expect, it } from "vitest";
import { createSandboxCommand, disableSandbox, enableSandbox, formatSandboxStatus } from "./sandbox";

const settings = { model: "test", apiFormat: "openai" as const, maxTurns: 1, permission: { mode: "default" as const } };

describe("SRT sandbox command", () => {
  it("enables and disables only the local SRT sandbox", () => {
    const enabled = enableSandbox(settings);
    expect(enabled.sandbox).toEqual({ enabled: true, failIfUnavailable: true });
    expect(disableSandbox(enabled).sandbox?.enabled).toBe(false);
  });
  it("reports SRT without a container backend", () => {
    expect(formatSandboxStatus(enableSandbox(settings))).toContain("Runtime: SRT");
    expect(createSandboxCommand().name()).toBe("sandbox");
  });
});
