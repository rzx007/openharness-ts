import type { DesktopModel } from "../../../shared/session-types"

const legacyDeepSeekPrefix = "deepseek/"

export function normalizeConfiguredModelId(
  models: DesktopModel[],
  configuredModel: string,
  configuredProvider: string | undefined
): string {
  if (configuredProvider !== "deepseek" || !configuredModel.startsWith(legacyDeepSeekPrefix)) {
    return configuredModel
  }

  const candidate = configuredModel.slice(legacyDeepSeekPrefix.length)
  return models.some((model) => model.id === candidate && model.providerName === "deepseek")
    ? candidate
    : configuredModel
}
