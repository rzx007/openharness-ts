import type { DesktopModel } from "../../../shared/session-types"

export function resolveBootstrapRuntimeSelection(
  models: DesktopModel[],
  configuredModel: string | undefined,
  configuredProvider: string | undefined
): { model: string | undefined; provider: string | undefined } {
  if (configuredProvider) {
    const providerModels = models.filter((item) => item.providerName === configuredProvider)
    if (providerModels.length > 0) {
      if (configuredModel && providerModels.some((item) => item.id === configuredModel)) {
        return { model: configuredModel, provider: configuredProvider }
      }
      return { model: providerModels[0]!.id, provider: configuredProvider }
    }
  }

  if (configuredModel) {
    const providers = uniqueModelProviders(models, configuredModel)
    return {
      model: configuredModel,
      provider: providers.length === 1 ? providers[0] : configuredProvider,
    }
  }

  return {
    model: models[0]?.id,
    provider: optionalProvider(models[0]?.providerName),
  }
}

function uniqueModelProviders(models: DesktopModel[], model: string): string[] {
  return [
    ...new Set(
      models
        .filter((item) => item.id === model)
        .map((item) => optionalProvider(item.providerName))
        .filter((item): item is string => Boolean(item))
    ),
  ]
}

function optionalProvider(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const provider = value.trim()
  if (!provider || provider.toLowerCase() === "configured") return undefined
  return provider
}
