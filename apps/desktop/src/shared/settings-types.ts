export type DesktopWorkStyle = "practical" | "efficient"

export interface DesktopSettingsSnapshot {
  workStyle: DesktopWorkStyle
}

export interface UpdateDesktopWorkStyleInput {
  workStyle: DesktopWorkStyle
}

export function buildDesktopSettingsSnapshot(
  settings: Record<string, unknown>
): DesktopSettingsSnapshot {
  return {
    workStyle: isDesktopWorkStyle(settings.workStyle) ? settings.workStyle : "practical",
  }
}

export function isDesktopWorkStyle(value: unknown): value is DesktopWorkStyle {
  return value === "practical" || value === "efficient"
}
