export type DesktopWorkStyle = "practical" | "efficient"
export type DesktopNotificationMode = "never" | "when_unfocused" | "always"
export type DesktopAgentEnvironment = "local" | "docker" | "unsupported_srt"

export interface DesktopSettingsSnapshot {
  workStyle: DesktopWorkStyle
  notificationMode: DesktopNotificationMode
  agentEnvironment: DesktopAgentEnvironment
  restartRequired: boolean
}

export interface UpdateDesktopWorkStyleInput {
  workStyle: DesktopWorkStyle
}

export interface UpdateDesktopNotificationModeInput {
  notificationMode: DesktopNotificationMode
}

export interface UpdateDesktopAgentEnvironmentInput {
  environment: "local" | "docker"
}

export function buildDesktopSettingsSnapshot(
  settings: Record<string, unknown>,
  preferences: Partial<{ notificationMode: unknown }> = {},
  options: Partial<{ restartRequired: boolean }> = {}
): DesktopSettingsSnapshot {
  return {
    workStyle: isDesktopWorkStyle(settings.workStyle) ? settings.workStyle : "practical",
    notificationMode: isDesktopNotificationMode(preferences.notificationMode)
      ? preferences.notificationMode
      : "when_unfocused",
    agentEnvironment: resolveDesktopAgentEnvironment(settings.sandbox),
    restartRequired: options.restartRequired ?? false,
  }
}

function resolveDesktopAgentEnvironment(value: unknown): DesktopAgentEnvironment {
  if (!isRecord(value) || value.enabled !== true) return "local"
  return value.backend === "docker" ? "docker" : "unsupported_srt"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function isDesktopWorkStyle(value: unknown): value is DesktopWorkStyle {
  return value === "practical" || value === "efficient"
}

export function isDesktopNotificationMode(value: unknown): value is DesktopNotificationMode {
  return value === "never" || value === "when_unfocused" || value === "always"
}
