import { afterEach, describe, expect, it, vi } from "vitest"

import {
  defaultUtilityPanelViewState,
  parseUtilityPanelViewStates,
  shouldMoveDraftPanelToSession,
  utilityPanelScopeId,
} from "./utility-panel-state"
import {
  moveUtilityPanelRuntimeState,
  readUtilityPanelRuntimeState,
  writeUtilityPanelRuntimeState,
} from "./utility-panel-runtime-state"

describe("utility panel state", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("uses one scope per session and a separate draft scope per project", () => {
    expect(utilityPanelScopeId("session-1", "project-1")).toBe("session:session-1")
    expect(utilityPanelScopeId("session-2", "project-1")).toBe("session:session-2")
    expect(utilityPanelScopeId(null, "project-1")).toBe("draft:project-1")
    expect(utilityPanelScopeId(null, null)).toBe("draft:outside-project")
  })

  it("defaults new scopes to a collapsed panel", () => {
    expect(defaultUtilityPanelViewState()).toEqual({
      open: false,
      maximized: false,
      layout: null,
    })
  })

  it("moves a draft only when it becomes a newly created session", () => {
    const knownSessionIds = new Set(["existing-session"])

    expect(shouldMoveDraftPanelToSession(null, "new-session", knownSessionIds)).toBe(true)
    expect(shouldMoveDraftPanelToSession(null, "existing-session", knownSessionIds)).toBe(false)
    expect(shouldMoveDraftPanelToSession("source-session", "fork-session", knownSessionIds)).toBe(
      false
    )
    expect(shouldMoveDraftPanelToSession("source-session", null, knownSessionIds)).toBe(false)
  })

  it("reads valid scoped states and rejects invalid layouts", () => {
    expect(
      parseUtilityPanelViewStates(
        JSON.stringify({
          "session:one": {
            open: true,
            maximized: true,
            layout: { conversation: 45, utility: 55 },
          },
          "session:two": {
            open: false,
            maximized: true,
            layout: { conversation: 100, utility: 0 },
          },
        })
      )
    ).toEqual({
      "session:one": {
        open: true,
        maximized: true,
        layout: { conversation: 45, utility: 55 },
      },
      "session:two": {
        open: false,
        maximized: false,
        layout: null,
      },
    })
  })

  it("moves a draft runtime instance into a newly created session", () => {
    const draftScope = "draft:test-runtime-move"
    const sessionScope = "session:test-runtime-move"
    const state = { activeTabId: "terminal-tab:one" }
    const persisted = new Map<string, string>([
      [
        "openharness.desktop.file-tabs.v2",
        JSON.stringify({ [draftScope]: { activePath: "README.md", paths: ["README.md"] } }),
      ],
    ])
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => persisted.get(key) ?? null,
      setItem: (key: string, value: string) => persisted.set(key, value),
    })

    writeUtilityPanelRuntimeState(draftScope, state)
    moveUtilityPanelRuntimeState(draftScope, sessionScope)

    expect(readUtilityPanelRuntimeState(draftScope)).toBeUndefined()
    expect(readUtilityPanelRuntimeState(sessionScope)).toBe(state)
    expect(JSON.parse(persisted.get("openharness.desktop.file-tabs.v2") ?? "{}")).toEqual({
      [sessionScope]: { activePath: "README.md", paths: ["README.md"] },
    })
  })
})
