export type SessionDestination = string | null

export type SessionNavigationState = {
  entries: SessionDestination[]
  index: number
}

export function createSessionNavigationState(
  destination: SessionDestination
): SessionNavigationState {
  return { entries: [destination], index: 0 }
}

export function recordSessionDestination(
  state: SessionNavigationState,
  destination: SessionDestination
): SessionNavigationState {
  if (state.entries[state.index] === destination) return state

  const entries = [...state.entries.slice(0, state.index + 1), destination]
  return { entries, index: entries.length - 1 }
}

export function moveSessionNavigation(
  state: SessionNavigationState,
  offset: -1 | 1
): SessionNavigationState {
  const index = Math.min(Math.max(state.index + offset, 0), state.entries.length - 1)
  return index === state.index ? state : { ...state, index }
}

export function currentSessionDestination(state: SessionNavigationState): SessionDestination {
  return state.entries[state.index] ?? null
}
