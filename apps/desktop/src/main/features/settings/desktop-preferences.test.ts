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

  it("reads a valid default opener id without dropping notification mode", async () => {
    await writeFile(
      join(userDataPath, "desktop-preferences.json"),
      JSON.stringify({ notificationMode: "always", defaultOpenerId: "vscode" }),
      "utf8"
    )
    const { getDesktopPreferences } = await import("./desktop-preferences")
    expect(getDesktopPreferences()).toEqual({
      notificationMode: "always",
      defaultOpenerId: "vscode",
    })
  })

  it("treats blank default opener ids as missing", async () => {
    await writeFile(
      join(userDataPath, "desktop-preferences.json"),
      JSON.stringify({ notificationMode: "never", defaultOpenerId: "   " }),
      "utf8"
    )
    const { getDesktopPreferences } = await import("./desktop-preferences")
    expect(getDesktopPreferences()).toEqual({ notificationMode: "never" })
  })

  it("keeps defaultOpenerId when patching notification mode", async () => {
    const { patchDesktopPreferences, getDesktopPreferences } = await import("./desktop-preferences")
    patchDesktopPreferences({ defaultOpenerId: "cursor" })
    patchDesktopPreferences({ notificationMode: "always" })
    expect(getDesktopPreferences()).toEqual({
      notificationMode: "always",
      defaultOpenerId: "cursor",
    })
  })

  it("keeps notification mode when patching defaultOpenerId", async () => {
    const { patchDesktopPreferences, getDesktopPreferences } = await import("./desktop-preferences")
    patchDesktopPreferences({ notificationMode: "never" })
    patchDesktopPreferences({ defaultOpenerId: "vscode" })
    expect(getDesktopPreferences()).toEqual({
      notificationMode: "never",
      defaultOpenerId: "vscode",
    })
  })

  it("throws when the preferences file cannot be written", async () => {
    const { mkdir } = await import("node:fs/promises")
    await mkdir(join(userDataPath, "desktop-preferences.json"))
    const { patchDesktopPreferences } = await import("./desktop-preferences")
    expect(() => patchDesktopPreferences({ defaultOpenerId: "vscode" })).toThrow()
  })
})
