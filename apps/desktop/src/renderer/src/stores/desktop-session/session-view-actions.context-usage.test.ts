import { describe, expect, it } from "vitest"

import type { DesktopSessionRun, DesktopSessionView } from "@shared/session-types"

import { didActiveRunFinish } from "./session-view-actions"

function viewWithRuns(runs: DesktopSessionRun[]): DesktopSessionView {
  return {
    cursor: 1,
    syncStatus: "connected",
    session: {
      id: "s1",
      cwd: "D:\\repo",
      title: "test",
      model: "test-model",
      status: "idle",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    },
    inputs: [],
    messages: [],
    parts: [],
    runs,
    tasks: [],
    permissions: [],
  }
}

function run(
  id: string,
  status: DesktopSessionRun["status"]
): DesktopSessionRun {
  return {
    id,
    sessionId: "s1",
    status,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

describe("didActiveRunFinish", () => {
  it("detects completed, failed, and interrupted transitions", () => {
    const previous = viewWithRuns([run("r1", "running")])
    expect(didActiveRunFinish(previous, viewWithRuns([run("r1", "completed")]))).toBe(true)
    expect(didActiveRunFinish(previous, viewWithRuns([run("r1", "failed")]))).toBe(true)
    expect(didActiveRunFinish(previous, viewWithRuns([run("r1", "interrupted")]))).toBe(true)
  })

  it("ignores still-active and brand-new terminal runs", () => {
    const previous = viewWithRuns([run("r1", "running")])
    expect(didActiveRunFinish(previous, viewWithRuns([run("r1", "running")]))).toBe(false)
    expect(didActiveRunFinish(previous, viewWithRuns([run("r2", "completed")]))).toBe(false)
    expect(didActiveRunFinish(null, viewWithRuns([run("r1", "completed")]))).toBe(false)
  })
})
