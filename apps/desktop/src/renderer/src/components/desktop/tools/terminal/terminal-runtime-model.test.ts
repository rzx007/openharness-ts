import { describe, expect, it } from "vitest"

import { resolveTerminalCreateTarget } from "./terminal-runtime-model"

describe("resolveTerminalCreateTarget", () => {
  const session = { id: "s1", projectId: undefined }

  it("uses the session execution environment by default", () => {
    expect(resolveTerminalCreateTarget({
      session,
    })).toEqual({
      runtime: "environment",
      scope: { kind: "session", sessionId: "s1" },
    })
  })

  it("uses the environment for native sessions too", () => {
    expect(resolveTerminalCreateTarget({
      session,
    })).toMatchObject({ runtime: "environment" })
  })
})
