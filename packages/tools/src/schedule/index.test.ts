import type { AgentCronEffects, ToolContext } from "@openharness/core";
import { describe, expect, it, vi } from "vitest";

import { cronCreateTool, cronListTool } from "./index.js";

function context(cron?: AgentCronEffects): ToolContext {
  return {
    cwd: "/repo",
    ...(cron
      ? {
          agent: {
            effects: { requestPermission: vi.fn(), cron },
          } as ToolContext["agent"],
        }
      : {}),
  };
}

describe("Cron tools", () => {
  it("does not create a second in-memory Cron world when the host has no Cron", async () => {
    const result = await cronListTool.execute({}, context());
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("does not provide") });
  });

  it("sends Cron changes to the host callback", async () => {
    const save = vi.fn(async (input) => ({ ...input, enabled: input.enabled ?? true }));
    const cron: AgentCronEffects = {
      save,
      remove: vi.fn(),
      list: vi.fn(async () => []),
      setEnabled: vi.fn(),
      trigger: vi.fn(),
    };

    const result = await cronCreateTool.execute({
      name: "check",
      schedule: "*/5 * * * *",
      command: "echo ok",
    }, context(cron));

    expect(result.isError).toBeUndefined();
    expect(save).toHaveBeenCalledWith({
      name: "check",
      expression: "*/5 * * * *",
      command: "echo ok",
      cwd: "/repo",
      timezone: undefined,
      enabled: true,
    });
  });
});
