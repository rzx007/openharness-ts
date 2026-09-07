import { describe, expect, it } from "vitest"

import { resolveTerminalCreateTarget } from "./terminal-runtime-model"

describe("resolveTerminalCreateTarget", () => {
  const session = { id: "s1", projectId: undefined }

  it("uses a session-scoped Docker terminal by default", () => {
    expect(resolveTerminalCreateTarget({
      agentEnvironment: "docker",
      session,
      explicitHost: false,
    })).toEqual({
      runtime: "sandbox",
      scope: { kind: "session", sessionId: "s1" },
    })
  })

  it("uses local runtime for local environments and explicit host requests", () => {
    expect(resolveTerminalCreateTarget({
      agentEnvironment: "local",
      session,
      explicitHost: false,
    })).toMatchObject({ runtime: "local" })
    expect(resolveTerminalCreateTarget({
      agentEnvironment: "docker",
      session,
      explicitHost: true,
    })).toMatchObject({ runtime: "local" })
  })
})
