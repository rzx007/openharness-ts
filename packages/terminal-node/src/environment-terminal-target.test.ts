import { describe, expect, it } from "vitest";

import { createHostTerminalTarget } from "./environment-terminal-target.js";

describe("createHostTerminalTarget", () => {
  it("keeps host and execution cwd identical for an explicit local terminal", async () => {
    const target = createHostTerminalTarget({
      cwd: "D:\\repo",
      shell: "powershell.exe",
    });

    expect(target).toMatchObject({
      command: "powershell.exe",
      args: [],
      hostCwd: "D:\\repo",
      executionCwd: "D:\\repo",
      shell: "powershell.exe",
    });
    await expect(target.signal("terminate")).resolves.toBeUndefined();
    await expect(target.close()).resolves.toBeUndefined();
  });
});
