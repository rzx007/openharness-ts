import { describe, expect, it } from "vitest"

import { resolveTerminalCreateTarget } from "./terminal-runtime-model"

describe("resolveTerminalCreateTarget", () => {
  const session = { id: "s1", projectId: undefined }

  it("uses the session execution environment by default", () => {
    expect(resolveTerminalCreateTarget({
      agentEnvironment: "docker",
      session,
      explicitHost: false,
    })).toEqual({
      runtime: "environment",
      scope: { kind: "session", sessionId: "s1" },
    })
  })

  it("uses the environment for native sessions and local only for explicit host requests", () => {
    expect(resolveTerminalCreateTarget({
      agentEnvironment: "local",
      session,
      explicitHost: false,
    })).toMatchObject({ runtime: "environment" })
    expect(resolveTerminalCreateTarget({
      agentEnvironment: "docker",
      session,
      explicitHost: true,
    })).toMatchObject({ runtime: "local" })
  })
})
