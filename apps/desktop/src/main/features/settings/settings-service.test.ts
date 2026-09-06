import { describe, expect, it } from "vitest"

import { buildDesktopSettingsSnapshot } from "../../../shared/settings-types"

describe("buildDesktopSettingsSnapshot", () => {
  it("defaults to practical work style", () => {
    expect(buildDesktopSettingsSnapshot({})).toEqual({
      workStyle: "practical",
      notificationMode: "when_unfocused",
      defaultOpenerId: null,
    })
  })

  it("preserves an efficient work style", () => {
    expect(buildDesktopSettingsSnapshot({ workStyle: "efficient" })).toEqual({
      workStyle: "efficient",
      notificationMode: "when_unfocused",
      defaultOpenerId: null,
    })
  })

  it("rejects unknown persisted values by falling back safely", () => {
    expect(buildDesktopSettingsSnapshot({ workStyle: "chatty" })).toEqual({
      workStyle: "practical",
      notificationMode: "when_unfocused",
      defaultOpenerId: null,
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

  it("defaults defaultOpenerId to null", () => {
    expect(buildDesktopSettingsSnapshot({})).toEqual({
      workStyle: "practical",
      notificationMode: "when_unfocused",
      defaultOpenerId: null,
    })
  })

  it("preserves a valid default opener id", () => {
    expect(
      buildDesktopSettingsSnapshot({}, { defaultOpenerId: "  vscode  " })
    ).toMatchObject({ defaultOpenerId: "vscode" })
  })

  it("rejects blank default opener ids", () => {
    expect(buildDesktopSettingsSnapshot({}, { defaultOpenerId: "   " })).toMatchObject({
      defaultOpenerId: null,
    })
  })
})
