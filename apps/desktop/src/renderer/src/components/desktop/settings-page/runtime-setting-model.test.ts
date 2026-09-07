import { describe, expect, it } from "vitest"

import { runtimeEnvironmentLabel, runtimeEnvironmentNotice } from "./runtime-setting-model"

describe("runtime setting model", () => {
  it("labels every persisted environment state", () => {
    expect(runtimeEnvironmentLabel("native")).toBe("本机")
    expect(runtimeEnvironmentLabel("wsl")).toBe("WSL")
  })

  it("explains restart and unsupported states", () => {
    expect(runtimeEnvironmentNotice("wsl", true)).toContain("重启")
    expect(runtimeEnvironmentNotice("native", false)).toBeNull()
  })
})
