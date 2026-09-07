import type { DesktopTerminalCreateInput } from "@shared/terminal-types"

type UserTerminalCreateInput = Required<Pick<DesktopTerminalCreateInput, "scope">> &
  Pick<DesktopTerminalCreateInput, "runtime" | "name" | "cols" | "rows">

export function userTerminalCreateInput(input: UserTerminalCreateInput): DesktopTerminalCreateInput {
  return {
    scope: input.scope,
    runtime: input.runtime,
    name: input.name,
    cols: input.cols,
    rows: input.rows,
  }
}
