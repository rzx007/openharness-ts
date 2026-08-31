import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let userDataPath = ""

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name !== "userData") throw new Error(`Unexpected path lookup: ${name}`)
      return userDataPath
    }),
  },
}))

describe("desktop preferences", () => {
  const temporaryRoots: string[] = []

  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), "openharness-desktop-preferences-"))
    temporaryRoots.push(userDataPath)
  })

  afterEach(async () => {
    vi.resetModules()
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    )
  })

  it("defaults notification mode when the preferences file does not exist", async () => {
    const { getDesktopPreferences } = await import("./desktop-preferences")

    expect(getDesktopPreferences()).toEqual({ notificationMode: "when_unfocused" })
  })

  it("reads a valid notification mode from the desktop preferences file", async () => {
    await writeFile(
      join(userDataPath, "desktop-preferences.json"),
      JSON.stringify({ notificationMode: "always" }),
      "utf8"
    )
    const { getDesktopPreferences } = await import("./desktop-preferences")

    expect(getDesktopPreferences()).toEqual({ notificationMode: "always" })
  })

  it("falls back safely when the notification mode is invalid", async () => {
    await writeFile(
      join(userDataPath, "desktop-preferences.json"),
      JSON.stringify({ notificationMode: "chatty" }),
      "utf8"
    )
    const { getDesktopPreferences } = await import("./desktop-preferences")

    expect(getDesktopPreferences()).toEqual({ notificationMode: "when_unfocused" })
  })

  it("falls back safely when the preferences file is malformed", async () => {
    await writeFile(join(userDataPath, "desktop-preferences.json"), "{", "utf8")
    const { getDesktopPreferences } = await import("./desktop-preferences")

    expect(getDesktopPreferences()).toEqual({ notificationMode: "when_unfocused" })
  })
})
