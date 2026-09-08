import type { DesktopSessionRecord } from "@shared/session-types"
import type { DesktopTerminalCreateInput } from "@shared/terminal-types"

export function resolveTerminalCreateTarget(input: {
  session: Pick<DesktopSessionRecord, "id" | "projectId">
}): Pick<DesktopTerminalCreateInput, "runtime"> &
  Required<Pick<DesktopTerminalCreateInput, "scope">> {
  return {
    runtime: "environment",
    scope: { kind: "session", sessionId: input.session.id },
  }
}

export function terminalRuntimeLabel(runtime: DesktopTerminalCreateInput["runtime"]): string {
  return runtime === "environment" ? "环境终端" : "本机终端"
}
