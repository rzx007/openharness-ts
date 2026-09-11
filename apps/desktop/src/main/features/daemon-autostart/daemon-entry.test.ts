import { describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({ app: { isPackaged: true, getAppPath: () => "D:/app" } }))
import { resolveDesktopDaemonMode } from "./daemon-entry"

describe("desktop daemon entry", () => {
  it("recognizes only fixed headless flags", () => {
    expect(resolveDesktopDaemonMode(["OpenHarness", "--daemon-service"])).toBe("service")
    expect(resolveDesktopDaemonMode(["OpenHarness", "--daemon-watchdog"])).toBe("watchdog")
    expect(resolveDesktopDaemonMode(["OpenHarness"])).toBeNull()
  })
})
