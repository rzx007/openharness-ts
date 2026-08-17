import { resolveSandboxPolicy } from "@openharness/sandbox";
import { describe, expect, it } from "vitest";
import { CronScheduler } from "./index.js";

describe("CronScheduler sandbox policy", () => {
  it("passes an explicit per-trigger policy to command execution", async () => {
    const scheduler = new CronScheduler();
    scheduler.upsertJob({
      name: "policy-triggered",
      expression: "* * * * *",
      command: `"${process.execPath}" -e "process.stdout.write('cron-policy-ok')"`,
      cwd: process.cwd(),
    });
    const policy = resolveSandboxPolicy({ cwd: process.cwd(), config: { enabled: false } });

    const result = await scheduler.trigger("policy-triggered", {
      policy,
      settings: {
        model: "test",
        apiFormat: "openai",
        maxTurns: 1,
        permission: { mode: "default" },
        sandbox: { enabled: true, backend: "docker", failIfUnavailable: true },
      },
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("cron-policy-ok");
  });
});
