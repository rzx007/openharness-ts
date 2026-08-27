import { describe, expect, it } from "vitest"

import { buildDesktopSettingsSnapshot } from "../../../shared/settings-types"

describe("buildDesktopSettingsSnapshot", () => {
  it("defaults to practical work style", () => {
    expect(buildDesktopSettingsSnapshot({})).toEqual({ workStyle: "practical" })
  })

  it("preserves an efficient work style", () => {
    expect(buildDesktopSettingsSnapshot({ workStyle: "efficient" })).toEqual({
      workStyle: "efficient",
    })
  })

  it("rejects unknown persisted values by falling back safely", () => {
    expect(buildDesktopSettingsSnapshot({ workStyle: "chatty" })).toEqual({
      workStyle: "practical",
    })
  })
})
