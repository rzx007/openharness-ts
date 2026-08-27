import { createEmptySessionRuntime } from "./operation-state"
import type { DesktopRuntimeState } from "./types"

export function createInitialRuntimeState(): DesktopRuntimeState {
  return {
    appOperations: {},
    projectOperations: {},
    newConversationRuntime: createEmptySessionRuntime(),
    sessionRuntimes: {},
  }
}
