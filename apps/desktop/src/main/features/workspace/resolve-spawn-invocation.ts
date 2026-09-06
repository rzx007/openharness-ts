import type { WorkspaceOpenerKind } from "../../../shared/workspace-types"

export function resolveSpawnInvocation(input: {
  platform: string
  kind: WorkspaceOpenerKind
  command: string
  args: string[]
  cwd: string
  comspec?: string
}): { command: string; args: string[] } {
  if (input.platform !== "win32" || input.kind !== "terminal") {
    return { command: input.command, args: input.args }
  }

  return {
    command: input.comspec ?? process.env.ComSpec ?? "cmd.exe",
    args: ["/c", "start", "", "/D", input.cwd, input.command, ...input.args],
  }
}
