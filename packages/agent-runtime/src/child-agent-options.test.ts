import { describe, expect, it } from "vitest";

import { deriveChildAgentOptions } from "./child-agent-options.js";

describe("deriveChildAgentOptions", () => {
  it("preserves the host boundary while applying child role overrides", () => {
    const settings = { model: "settings-model" } as any;
    const capabilityOverrides = { memory: false } as const;
    const effects = { requestPermission: async () => ({ status: "denied" as const }) };

    const options = deriveChildAgentOptions({
      configuration: {
        model: "parent-model",
        systemPrompt: "parent prompt",
        permissionMode: "plan",
        hostToolCeiling: ["Read", "Grep", "Agent"],
        roleAllowedTools: ["Agent"],
        disallowedTools: ["Write", "Bash"],
        maxTurns: 9,
        effort: "high",
      },
      settings,
      capabilityOverrides,
      effects,
      child: {
        description: "Inspect the project",
        prompt: "Find the relevant files",
        agent: "Explore",
        cwd: "/repo/requested",
        model: "child-model",
        systemPrompt: "child prompt",
        permissionMode: "default",
        allowedTools: ["Read", "Grep"],
        disallowedTools: ["Bash", "Edit"],
        maxTurns: 4,
        effort: "medium",
      },
      cwd: "/repo/leased",
      sessionId: "child-session",
    });

    expect(options).toMatchObject({
      settings,
      cwd: "/repo/leased",
      sessionId: "child-session",
      model: "child-model",
      systemPrompt: "child prompt",
      permissionMode: "default",
      hostToolCeiling: ["Read", "Grep", "Agent"],
      roleAllowedTools: ["Read", "Grep"],
      disallowedTools: ["Write", "Bash", "Edit"],
      maxTurns: 4,
      effort: "medium",
    });
    expect(options.capabilityOverrides).toBe(capabilityOverrides);
    expect(options.effects).toBe(effects);
  });

  it("inherits parent runtime choices and ignores unsupported child effort values", () => {
    const options = deriveChildAgentOptions({
      configuration: {
        model: "parent-model",
        systemPrompt: "parent prompt",
        permissionMode: "full_auto",
        maxTurns: 12,
        effort: "low",
      },
      settings: {} as any,
      child: {
        description: "Inspect",
        prompt: "Inspect",
        agent: "worker",
        cwd: "/repo/requested",
        effort: "ultra",
      },
      cwd: "/repo/leased",
      sessionId: "child-session",
    });

    expect(options).toMatchObject({
      model: "parent-model",
      systemPrompt: "parent prompt",
      permissionMode: "full_auto",
      maxTurns: 12,
      effort: "low",
    });
    expect(options.roleAllowedTools).toBeUndefined();
    expect(options.disallowedTools).toBeUndefined();
  });
});
