import type { DesktopTerminalCreateInput } from "@shared/terminal-types"

export function userTerminalCreateInput(input: {
  projectId: string
  runtime: DesktopTerminalCreateInput["runtime"]
  name: string
  cols: number
  rows: number
}): DesktopTerminalCreateInput {
  return {
    projectId: input.projectId,
    runtime: input.runtime,
    name: input.name,
    cols: input.cols,
    rows: input.rows,
  }
}
