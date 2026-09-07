import type { DesktopAgentEnvironment } from "@shared/settings-types"
import type { DesktopSessionRecord } from "@shared/session-types"
import type { DesktopTerminalCreateInput } from "@shared/terminal-types"

export function resolveTerminalCreateTarget(input: {
  agentEnvironment: DesktopAgentEnvironment
  session: Pick<DesktopSessionRecord, "id" | "projectId">
  explicitHost: boolean
}): Pick<DesktopTerminalCreateInput, "runtime" | "scope"> {
  return {
    runtime: input.explicitHost ? "local" : "environment",
    scope: { kind: "session", sessionId: input.session.id },
  }
}

export function terminalRuntimeLabel(runtime: DesktopTerminalCreateInput["runtime"]): string {
  return runtime === "environment" ? "环境终端" : "本机终端"
}
