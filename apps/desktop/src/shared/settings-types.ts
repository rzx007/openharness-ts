export type DesktopWorkStyle = "practical" | "efficient"
export type DesktopNotificationMode = "never" | "when_unfocused" | "always"

export interface DesktopSettingsSnapshot {
  workStyle: DesktopWorkStyle
  notificationMode: DesktopNotificationMode
}

export interface UpdateDesktopWorkStyleInput {
  workStyle: DesktopWorkStyle
}

export interface UpdateDesktopNotificationModeInput {
  notificationMode: DesktopNotificationMode
}

export function buildDesktopSettingsSnapshot(
  settings: Record<string, unknown>,
  preferences: Partial<{ notificationMode: unknown }> = {}
): DesktopSettingsSnapshot {
  return {
    workStyle: isDesktopWorkStyle(settings.workStyle) ? settings.workStyle : "practical",
    notificationMode: isDesktopNotificationMode(preferences.notificationMode)
      ? preferences.notificationMode
      : "when_unfocused",
  }
}

export function isDesktopWorkStyle(value: unknown): value is DesktopWorkStyle {
  return value === "practical" || value === "efficient"
}

export function isDesktopNotificationMode(value: unknown): value is DesktopNotificationMode {
  return value === "never" || value === "when_unfocused" || value === "always"
}
