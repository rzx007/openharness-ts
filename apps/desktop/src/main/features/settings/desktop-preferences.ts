import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { app } from "electron"

import {
  isDesktopNotificationMode,
  type DesktopNotificationMode,
} from "../../../shared/settings-types"

export interface DesktopPreferences {
  notificationMode: DesktopNotificationMode
}

const defaults: DesktopPreferences = {
  notificationMode: "when_unfocused",
}

export function getDesktopPreferences(): DesktopPreferences {
  const filePath = getDesktopPreferencesPath()
  if (!existsSync(filePath)) return defaults

  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Partial<DesktopPreferences>
    return {
      notificationMode: isDesktopNotificationMode(raw.notificationMode)
        ? raw.notificationMode
        : defaults.notificationMode,
    }
  } catch {
    return defaults
  }
}

export function patchDesktopPreferences(patch: Partial<DesktopPreferences>): DesktopPreferences {
  const next = { ...getDesktopPreferences(), ...patch }

  try {
    writeFileSync(getDesktopPreferencesPath(), JSON.stringify(next, null, 2), "utf8")
  } catch (error) {
    console.warn("[settings] failed to persist desktop preferences", error)
  }

  return next
}

export function getDesktopPreferencesPath(): string {
  return join(app.getPath("userData"), "desktop-preferences.json")
}
