import { describe, expect, it } from "vitest"

import { buildDesktopSettingsSnapshot } from "../../../shared/settings-types"

describe("buildDesktopSettingsSnapshot", () => {
  it("defaults to practical work style", () => {
    expect(buildDesktopSettingsSnapshot({})).toEqual({
      workStyle: "practical",
      notificationMode: "when_unfocused",
    })
  })

  it("preserves an efficient work style", () => {
    expect(buildDesktopSettingsSnapshot({ workStyle: "efficient" })).toEqual({
      workStyle: "efficient",
      notificationMode: "when_unfocused",
    })
  })

  it("rejects unknown persisted values by falling back safely", () => {
    expect(buildDesktopSettingsSnapshot({ workStyle: "chatty" })).toEqual({
      workStyle: "practical",
      notificationMode: "when_unfocused",
    })
  })

  it("preserves a valid desktop notification mode", () => {
    expect(buildDesktopSettingsSnapshot({}, { notificationMode: "always" })).toMatchObject({
      notificationMode: "always",
    })
  })

  it("rejects unknown desktop notification values by falling back safely", () => {
    expect(buildDesktopSettingsSnapshot({}, { notificationMode: "chatty" })).toMatchObject({
      notificationMode: "when_unfocused",
    })
  })
})
