const utilityPanelRuntimeStates = new Map<string, unknown>()
export const persistedUtilityFileTabsKey = "openharness.desktop.file-tabs.v2"

export function readUtilityPanelRuntimeState<T>(scopeId: string): T | undefined {
  return utilityPanelRuntimeStates.get(scopeId) as T | undefined
}

export function writeUtilityPanelRuntimeState<T>(scopeId: string, state: T): void {
  utilityPanelRuntimeStates.set(scopeId, state)
}

export function moveUtilityPanelRuntimeState(fromScopeId: string, toScopeId: string): void {
  if (fromScopeId === toScopeId || utilityPanelRuntimeStates.has(toScopeId)) return
  const runtimeState = utilityPanelRuntimeStates.get(fromScopeId)
  if (runtimeState !== undefined) {
    utilityPanelRuntimeStates.set(toScopeId, runtimeState)
    utilityPanelRuntimeStates.delete(fromScopeId)
  }

  try {
    const raw = localStorage.getItem(persistedUtilityFileTabsKey)
    if (!raw) return
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return
    const persistedStates = parsed as Record<string, unknown>
    if (!persistedStates[fromScopeId] || persistedStates[toScopeId]) return
    const nextPersistedStates = {
      ...persistedStates,
      [toScopeId]: persistedStates[fromScopeId],
    }
    delete nextPersistedStates[fromScopeId]
    localStorage.setItem(persistedUtilityFileTabsKey, JSON.stringify(nextPersistedStates))
  } catch {
    // The in-memory state has already moved; persistence is best-effort UI restoration.
  }
}
