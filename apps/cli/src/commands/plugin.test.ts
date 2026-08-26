import { describe, expect, it } from "vitest";
import type { PluginInfo } from "@openharness/client";
import { createPluginCommand, formatPluginList } from "./plugin";

function plugin(partial: Partial<PluginInfo> = {}): PluginInfo {
  return {
    identity: {
      id: "context7",
      name: "context7",
      displayName: "Context7",
      version: "1.2.3",
    },
    origin: "converted",
    sourceFormat: "claude-code",
    scope: "project",
    enabled: true,
    installation: "installed",
    activation: "active",
    toolRuntime: {
      state: "active",
      declaredEntries: 2,
      activatableEntries: 2,
      hostCount: 1,
      registeredToolCount: 2,
    },
    inventory: { commands: 1, tools: 2 },
    permissions: { requested: ["network"], approved: ["network"], missing: [] },
    diagnostics: [],
    ...partial,
  };
}

describe("formatPluginList", () => {
  it("formats an aligned human-readable summary", () => {
    const output = formatPluginList({ plugins: [plugin()], warnings: [] });
    expect(output).toContain("PLUGIN");
    expect(output).toContain("Context7  1.2.3");
    expect(output).toContain("project  enabled  active");
    expect(output).toContain("2/2");
  });

  it("includes runtime, permissions, diagnostics, and warnings in verbose mode", () => {
    const output = formatPluginList(
      {
        plugins: [
          plugin({
            permissions: {
              requested: ["network", "process"],
              approved: ["network"],
              missing: ["process"],
            },
            diagnostics: [
              {
                severity: "warning",
                phase: "activate",
                code: "PLUGIN_PARTIAL",
                message: "One entry failed",
              },
            ],
          }),
        ],
        warnings: ["Cache was rebuilt"],
      },
      true,
    );
    expect(output).toContain("origin       converted (claude-code)");
    expect(output).toContain("tool runtime active; hosts=1; registered=2");
    expect(output).toContain("missing       process");
    expect(output).toContain("PLUGIN_PARTIAL: One entry failed");
    expect(output).toContain("warning: Cache was rebuilt");
  });

  it("uses a clear empty state", () => {
    expect(formatPluginList({ plugins: [], warnings: [] })).toBe(
      "No Native Plugins installed.",
    );
  });

  it("keeps columns aligned for wide CJK plugin names", () => {
    const output = formatPluginList({
      plugins: [plugin({ identity: { id: "docs", name: "docs", displayName: "文档助手", version: "1.0.0" } })],
      warnings: [],
    });
    expect(output).toContain("文档助手  1.0.0");
  });
});

describe("createPluginCommand", () => {
  it("registers list output options", () => {
    const list = createPluginCommand().commands.find(
      (command) => command.name() === "list",
    );
    expect(list?.options.map((option) => option.long)).toEqual([
      "--cwd",
      "--verbose",
      "--json",
    ]);
  });
});
