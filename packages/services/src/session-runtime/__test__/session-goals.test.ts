import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { SessionStore } from "../store.js"

describe("SessionStore goals", () => {
  it("persists one open goal and protects revisions", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-goal-"))
    const path = join(directory, "store.db")
    const store = new SessionStore({ path })
    try {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" })
      const goal = store.createGoal({ sessionId: "s1", objective: "完成目标功能", maxAutoTurns: 20 })
      const request = store.beginGoalRequest({ requestId: "request-1", sessionId: "s1", fingerprint: "same" })
      expect(store.beginGoalRequest({ requestId: "request-1", sessionId: "s1", fingerprint: "same" })).toEqual(request)
      expect(() => store.beginGoalRequest({ requestId: "request-1", sessionId: "s1", fingerprint: "different" })).toThrowError("session_goal_request_conflict")
      store.settleGoalRequest("request-1", { status: "completed", goalId: goal.id, result: { goalId: goal.id } })
      expect(store.getCurrentGoal("s1")).toMatchObject({ id: goal.id, status: "active", revision: 0 })
      expect(() => store.createGoal({ sessionId: "s1", objective: "重复目标", maxAutoTurns: 20 })).toThrow()
      const paused = store.updateGoal(goal.id, { expectedRevision: 0, status: "paused" })
      expect(paused).toMatchObject({ status: "paused", revision: 1 })
      expect(() => store.updateGoal(goal.id, { expectedRevision: 0, status: "active" })).toThrowError("session_goal_revision_conflict")
      store.close()
      const reloaded = new SessionStore({ path })
      expect(reloaded.getGoal(goal.id)).toMatchObject({ status: "paused", revision: 1 })
      reloaded.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
