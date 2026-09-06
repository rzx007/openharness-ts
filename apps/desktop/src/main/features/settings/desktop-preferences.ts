import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { app } from "electron"

import {
  isDesktopNotificationMode,
  normalizeDefaultOpenerId,
  normalizeDefaultTerminalShellId,
  type DesktopNotificationMode,
} from "../../../shared/settings-types"

export interface DesktopPreferences {
  notificationMode: DesktopNotificationMode
  defaultOpenerId?: string
  defaultTerminalShellId?: string
}

type DesktopPreferencesPatch = Partial<DesktopPreferences> & {
  defaultTerminalShellId?: string | null
}

const defaults: DesktopPreferences = {
  notificationMode: "when_unfocused",
}

export function getDesktopPreferences(): DesktopPreferences {
  const filePath = getDesktopPreferencesPath()
  if (!existsSync(filePath)) return defaults

  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Partial<DesktopPreferences>
    const defaultOpenerId = normalizeDefaultOpenerId(raw.defaultOpenerId)
    const defaultTerminalShellId = normalizeDefaultTerminalShellId(raw.defaultTerminalShellId)
    return {
      notificationMode: isDesktopNotificationMode(raw.notificationMode)
        ? raw.notificationMode
        : defaults.notificationMode,
      ...(defaultOpenerId ? { defaultOpenerId } : {}),
      ...(defaultTerminalShellId ? { defaultTerminalShellId } : {}),
    }
  } catch {
    return defaults
  }
}

export function patchDesktopPreferences(patch: DesktopPreferencesPatch): DesktopPreferences {
  const next = { ...getDesktopPreferences(), ...patch }
  const defaultOpenerId = normalizeDefaultOpenerId(next.defaultOpenerId)
  const defaultTerminalShellId = normalizeDefaultTerminalShellId(next.defaultTerminalShellId)
  const persisted: DesktopPreferences = {
    notificationMode: next.notificationMode,
    ...(defaultOpenerId ? { defaultOpenerId } : {}),
    ...(defaultTerminalShellId ? { defaultTerminalShellId } : {}),
  }

  writeFileSync(getDesktopPreferencesPath(), JSON.stringify(persisted, null, 2), "utf8")
  return persisted
}

export function getDesktopPreferencesPath(): string {
  return join(app.getPath("userData"), "desktop-preferences.json")
}
