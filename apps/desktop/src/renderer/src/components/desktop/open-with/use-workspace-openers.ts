import { useEffect, useState } from "react"

import type { WorkspaceOpener } from "@shared/workspace-types"

const persistedOpenerKey = "openharness.desktop.open-with.v1"
const openerChangedEvent = "openharness:open-with-changed"

let cachedOpeners: WorkspaceOpener[] | null = null
let inflight: Promise<WorkspaceOpener[]> | null = null

export function useWorkspaceOpeners(): {
  openers: WorkspaceOpener[]
  selected: WorkspaceOpener | null
  ready: boolean
} {
  const [openers, setOpeners] = useState<WorkspaceOpener[]>(cachedOpeners ?? [])
  const [selectedId, setSelectedId] = useState<string | null>(readPersistedOpenerId)
  const [ready, setReady] = useState(cachedOpeners !== null)
  const selected = resolveSelectedOpener(openers, selectedId)

  useEffect(() => {
    let cancelled = false
    void loadOpeners()
      .then((next) => {
        if (cancelled) return
        setOpeners(next)
        setReady(true)
      })
      .catch(() => {
        if (cancelled) return
        setOpeners([])
        setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const syncFromStorage = (event: StorageEvent): void => {
      if (event.key === persistedOpenerKey) setSelectedId(readPersistedOpenerId())
    }
    const syncFromEvent = (event: Event): void => {
      const openerId = (event as CustomEvent<string>).detail
      if (typeof openerId === "string") setSelectedId(openerId)
    }
    window.addEventListener("storage", syncFromStorage)
    window.addEventListener(openerChangedEvent, syncFromEvent)
    return () => {
      window.removeEventListener("storage", syncFromStorage)
      window.removeEventListener(openerChangedEvent, syncFromEvent)
    }
  }, [])

  return { openers, selected, ready }
}

export async function launchWorkspaceOpener(input: {
  openerId: string
  path: string
  rootPath?: string
  persist?: boolean
}): Promise<void> {
  if (input.persist) writePersistedOpenerId(input.openerId)
  await window.desktop.workspace.openWith({
    openerId: input.openerId,
    path: input.path,
    rootPath: input.rootPath,
  })
}

function loadOpeners(): Promise<WorkspaceOpener[]> {
  if (cachedOpeners) return Promise.resolve(cachedOpeners)
  if (!inflight) {
    inflight = window.desktop.workspace
      .listOpeners()
      .then((next) => {
        cachedOpeners = next
        return next
      })
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

function resolveSelectedOpener(
  openers: WorkspaceOpener[],
  selectedId: string | null
): WorkspaceOpener | null {
  if (openers.length === 0) return null
  return (
    openers.find((opener) => opener.id === selectedId) ??
    openers.find((opener) => opener.id === "cursor") ??
    openers.find((opener) => opener.id === "vscode") ??
    openers[0]
  )
}

function readPersistedOpenerId(): string | null {
  try {
    const value = localStorage.getItem(persistedOpenerKey)
    return value?.trim() || null
  } catch {
    return null
  }
}

function writePersistedOpenerId(openerId: string): void {
  try {
    localStorage.setItem(persistedOpenerKey, openerId)
    window.dispatchEvent(new CustomEvent(openerChangedEvent, { detail: openerId }))
  } catch {
    // Ignore storage quota and private-mode failures.
  }
}
