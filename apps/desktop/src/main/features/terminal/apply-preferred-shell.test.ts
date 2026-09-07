import { describe, expect, it } from "vitest"

import { applyPreferredTerminalShell } from "./apply-preferred-shell"

const base = {
  projectId: "p1",
  runtime: "local" as const,
  cols: 80,
  rows: 24,
}

describe("applyPreferredTerminalShell", () => {
  it("fills shell for local terminals when the caller omitted it", () => {
    expect(applyPreferredTerminalShell(base, "C:\\Pwsh\\pwsh.exe").shell).toBe("C:\\Pwsh\\pwsh.exe")
  })

  it("does not override an explicit shell or a disabled environment preference", () => {
    expect(
      applyPreferredTerminalShell({ ...base, shell: "C:\\Custom\\bash.exe" }, "C:\\Pwsh\\pwsh.exe")
        .shell
    ).toBe("C:\\Custom\\bash.exe")
    expect(
      applyPreferredTerminalShell({ ...base, runtime: "environment" }, "C:\\Pwsh\\pwsh.exe", false).shell
    ).toBeUndefined()
  })

  it("omits shell when no preferred command is available", () => {
    expect(applyPreferredTerminalShell(base, undefined).shell).toBeUndefined()
  })
})
