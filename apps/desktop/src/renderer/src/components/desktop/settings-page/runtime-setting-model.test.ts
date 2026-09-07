import { describe, expect, it } from "vitest"

import { runtimeEnvironmentLabel, runtimeEnvironmentNotice } from "./runtime-setting-model"

describe("runtime setting model", () => {
  it("labels every persisted environment state", () => {
    expect(runtimeEnvironmentLabel("local")).toBe("本机")
    expect(runtimeEnvironmentLabel("docker")).toBe("Docker 沙箱")
    expect(runtimeEnvironmentLabel("unsupported_srt")).toBe("旧 SRT 配置（不支持）")
  })

  it("explains restart and unsupported states", () => {
    expect(runtimeEnvironmentNotice("docker", true)).toContain("重启")
    expect(runtimeEnvironmentNotice("unsupported_srt", false)).toContain("重新选择")
  })
})
