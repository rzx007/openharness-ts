import { useEffect, useState } from "react"

import type { WorkspaceOpener } from "@shared/workspace-types"

import { resolveSelectedOpener } from "./resolve-selected-opener"

let cachedOpeners: WorkspaceOpener[] | null = null
let inflight: Promise<WorkspaceOpener[]> | null = null

export function useWorkspaceOpeners(): {
  openers: WorkspaceOpener[]
  selected: WorkspaceOpener | null
  ready: boolean
} {
  const [openers, setOpeners] = useState<WorkspaceOpener[]>(cachedOpeners ?? [])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preferenceReady, setPreferenceReady] = useState(false)
  const [ready, setReady] = useState(cachedOpeners !== null)
  const selected = preferenceReady ? resolveSelectedOpener(openers, selectedId) : null

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
    let cancelled = false
    void window.desktop.settings
      .snapshot()
      .then((snapshot) => {
        if (cancelled) return
        setSelectedId(snapshot.defaultOpenerId)
      })
      .catch(() => {
        if (cancelled) return
        setSelectedId(null)
      })
      .finally(() => {
        if (!cancelled) setPreferenceReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { openers, selected, ready }
}

export async function launchWorkspaceOpener(input: {
  openerId: string
  path: string
  rootPath?: string
}): Promise<void> {
  await window.desktop.workspace.openWith({
    openerId: input.openerId,
    path: input.path,
    rootPath: input.rootPath,
  })
}

export async function launchProjectFolderOpener(
  openerId: string,
  folderPath: string
): Promise<void> {
  await launchWorkspaceOpener({ openerId, path: folderPath, rootPath: folderPath })
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
