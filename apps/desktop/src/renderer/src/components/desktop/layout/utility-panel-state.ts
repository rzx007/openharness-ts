export type UtilityPanelLayout = Record<string, number>

export type UtilityPanelViewState = {
  open: boolean
  maximized: boolean
  layout: UtilityPanelLayout | null
}

export type UtilityPanelViewStates = Record<string, UtilityPanelViewState>

const persistedUtilityPanelStatesKey = "openharness.desktop.utility-panel-states.v2"

export function utilityPanelScopeId(
  activeSessionId: string | null,
  selectedProjectId: string | null
): string {
  if (activeSessionId) return `session:${activeSessionId}`
  return `draft:${selectedProjectId ?? "outside-project"}`
}

export function shouldMoveDraftPanelToSession(
  previousActiveSessionId: string | null,
  nextActiveSessionId: string | null,
  knownSessionIds: ReadonlySet<string>
): boolean {
  return (
    previousActiveSessionId === null &&
    nextActiveSessionId !== null &&
    !knownSessionIds.has(nextActiveSessionId)
  )
}

export function defaultUtilityPanelViewState(): UtilityPanelViewState {
  return {
    open: false,
    maximized: false,
    layout: null,
  }
}

export function readPersistedUtilityPanelStates(): UtilityPanelViewStates {
  try {
    return parseUtilityPanelViewStates(localStorage.getItem(persistedUtilityPanelStatesKey))
  } catch {
    return {}
  }
}

export function writePersistedUtilityPanelStates(states: UtilityPanelViewStates): void {
  try {
    localStorage.setItem(persistedUtilityPanelStatesKey, JSON.stringify(states))
  } catch {
    // Panel state is recoverable UI state; storage failures must not interrupt the desktop app.
  }
}

export function parseUtilityPanelViewStates(raw: string | null): UtilityPanelViewStates {
  if (!raw) return {}

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}

    const states: UtilityPanelViewStates = {}
    for (const [scopeId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue
      const record = value as Record<string, unknown>
      const open = record.open === true
      const maximized = open && record.maximized === true
      states[scopeId] = {
        open,
        maximized,
        layout: parseLayout(record.layout),
      }
    }
    return states
  } catch {
    return {}
  }
}

function parseLayout(value: unknown): UtilityPanelLayout | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const conversation = Number(record.conversation)
  const utility = Number(record.utility)
  if (!Number.isFinite(conversation) || !Number.isFinite(utility)) return null
  if (conversation <= 0 || utility <= 0) return null
  return { conversation, utility }
}
