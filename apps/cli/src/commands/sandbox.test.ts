import { describe, expect, it } from "vitest";
import {
  applySandboxOffConfig,
  applySandboxOnConfig,
  createSandboxCommand,
  formatSandboxStatus,
} from "./sandbox";
import type { Settings } from "@openharness/core";

const settings: Settings = {
  model: "m",
  apiFormat: "openai",
  maxTurns: 1,
  permission: { mode: "default" },
};

describe("sandbox command config", () => {
  it("enables docker sandbox with bridge networking by default", () => {
    const next = applySandboxOnConfig(settings, {});

    expect(next.sandbox).toMatchObject({
      enabled: true,
      backend: "docker",
      failIfUnavailable: true,
      network: { mode: "bridge" },
      docker: {
        image: "openharness-sandbox:latest",
        autoBuildImage: true,
        reuseContainer: true,
      },
    });
  });

  it("applies docker image, dns, proxy, and no-build options", () => {
    const next = applySandboxOnConfig(settings, {
      image: "node:22-bookworm",
      dns: "1.1.1.1, 8.8.8.8",
      proxy: "http://host.docker.internal:7890",
      build: false,
      reuse: false,
      net: "proxy",
    });

    expect(next.sandbox?.network?.mode).toBe("proxy");
    expect(next.sandbox?.docker?.image).toBe("node:22-bookworm");
    expect(next.sandbox?.docker?.autoBuildImage).toBe(false);
    expect(next.sandbox?.docker?.reuseContainer).toBe(false);
    expect(next.sandbox?.docker?.dns).toEqual(["1.1.1.1", "8.8.8.8"]);
    expect(next.sandbox?.docker?.extraEnv).toMatchObject({
      HTTP_PROXY: "http://host.docker.internal:7890",
      HTTPS_PROXY: "http://host.docker.internal:7890",
      http_proxy: "http://host.docker.internal:7890",
      https_proxy: "http://host.docker.internal:7890",
    });
  });

  it("supports fail-open and srt backend", () => {
    const next = applySandboxOnConfig(settings, {
      backend: "srt",
      failOpen: true,
    });

    expect(next.sandbox?.backend).toBe("srt");
    expect(next.sandbox?.failIfUnavailable).toBe(false);
  });

  it("disables sandbox while preserving existing config", () => {
    const enabled = applySandboxOnConfig(settings, { image: "node:22-bookworm" });
    const disabled = applySandboxOffConfig(enabled);

    expect(disabled.sandbox?.enabled).toBe(false);
    expect(disabled.sandbox?.backend).toBe("docker");
    expect(disabled.sandbox?.docker?.image).toBe("node:22-bookworm");
  });

  it("formats sandbox status", () => {
    const next = applySandboxOnConfig(settings, { image: "node:22-bookworm" });
    const status = formatSandboxStatus(next);

    expect(status).toContain("Sandbox: enabled");
    expect(status).toContain("Backend: docker");
    expect(status).toContain("Network: bridge");
    expect(status).toContain("Image: node:22-bookworm");
    expect(status).toContain("Reuse container: true");
  });

  it("creates a sandbox command", () => {
    const cmd = createSandboxCommand();
    expect(cmd.name()).toBe("sandbox");
    expect(cmd.commands.map((sub) => sub.name())).toContain("clean");
  });
});
