import type { DesktopAgentEnvironment } from "@shared/settings-types"

const LABELS: Record<DesktopAgentEnvironment, string> = {
  local: "本机",
  docker: "Docker 沙箱",
  unsupported_srt: "旧 SRT 配置（不支持）",
}

export function runtimeEnvironmentLabel(environment: DesktopAgentEnvironment): string {
  return LABELS[environment]
}

export function runtimeEnvironmentNotice(
  environment: DesktopAgentEnvironment,
  restartRequired: boolean
): string | null {
  if (restartRequired) return "已保存，重启 OpenHarness 后生效。"
  if (environment === "unsupported_srt") {
    return "当前是旧 SRT 配置，桌面应用不支持；请重新选择本机或 Docker 沙箱。"
  }
  return null
}
