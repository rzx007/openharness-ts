import { describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({ app: { isPackaged: true, getAppPath: () => "D:/app" } }))
vi.mock("@openharness/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openharness/core")>()),
  loadSettings: vi.fn(async () => ({ daemon: { autoStart: false } })),
}))

import { resolveDesktopDaemonMode } from "./daemon-entry"

describe("desktop daemon entry", () => {
  it("recognizes only fixed headless flags", () => {
    expect(resolveDesktopDaemonMode(["OpenHarness", "--daemon-service"])).toBe("service")
    expect(resolveDesktopDaemonMode(["OpenHarness", "--daemon-watchdog"])).toBe("watchdog")
    expect(resolveDesktopDaemonMode(["OpenHarness"])).toBeNull()
  })
})
