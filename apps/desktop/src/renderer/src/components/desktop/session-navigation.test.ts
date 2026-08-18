import { describe, expect, it } from "vitest"

import {
  createSessionNavigationState,
  currentSessionDestination,
  moveSessionNavigation,
  recordSessionDestination,
} from "./session-navigation"

describe("session navigation", () => {
  it("records destinations and moves backward and forward", () => {
    let state = createSessionNavigationState(null)
    state = recordSessionDestination(state, "session-a")
    state = recordSessionDestination(state, "session-b")

    state = moveSessionNavigation(state, -1)
    expect(currentSessionDestination(state)).toBe("session-a")

    state = moveSessionNavigation(state, 1)
    expect(currentSessionDestination(state)).toBe("session-b")
  })

  it("drops the forward branch after a new destination is opened", () => {
    let state = createSessionNavigationState("session-a")
    state = recordSessionDestination(state, "session-b")
    state = moveSessionNavigation(state, -1)
    state = recordSessionDestination(state, "session-c")

    expect(state.entries).toEqual(["session-a", "session-c"])
    expect(moveSessionNavigation(state, 1)).toBe(state)
  })

  it("does not add duplicate consecutive destinations", () => {
    const state = createSessionNavigationState("session-a")
    expect(recordSessionDestination(state, "session-a")).toBe(state)
  })
})
