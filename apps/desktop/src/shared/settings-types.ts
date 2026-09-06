export type DesktopWorkStyle = "practical" | "efficient"
export type DesktopNotificationMode = "never" | "when_unfocused" | "always"

export interface DesktopSettingsSnapshot {
  workStyle: DesktopWorkStyle
  notificationMode: DesktopNotificationMode
  defaultOpenerId: string | null
  defaultTerminalShellId: string | null
}

export interface UpdateDesktopWorkStyleInput {
  workStyle: DesktopWorkStyle
}

export interface UpdateDesktopNotificationModeInput {
  notificationMode: DesktopNotificationMode
}

export interface UpdateDesktopDefaultOpenerInput {
  defaultOpenerId: string
}

export interface UpdateDesktopDefaultTerminalShellInput {
  defaultTerminalShellId: string | null
}

export function normalizeDefaultOpenerId(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function normalizeDefaultTerminalShellId(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed || trimmed === "system") return null
  return trimmed
}

export function buildDesktopSettingsSnapshot(
  settings: Record<string, unknown>,
  preferences: Partial<{
    notificationMode: unknown
    defaultOpenerId: unknown
    defaultTerminalShellId: unknown
  }> = {}
): DesktopSettingsSnapshot {
  return {
    workStyle: isDesktopWorkStyle(settings.workStyle) ? settings.workStyle : "practical",
    notificationMode: isDesktopNotificationMode(preferences.notificationMode)
      ? preferences.notificationMode
      : "when_unfocused",
    defaultOpenerId: normalizeDefaultOpenerId(preferences.defaultOpenerId),
    defaultTerminalShellId: normalizeDefaultTerminalShellId(preferences.defaultTerminalShellId),
  }
}

export function isDesktopWorkStyle(value: unknown): value is DesktopWorkStyle {
  return value === "practical" || value === "efficient"
}

export function isDesktopNotificationMode(value: unknown): value is DesktopNotificationMode {
  return value === "never" || value === "when_unfocused" || value === "always"
}
