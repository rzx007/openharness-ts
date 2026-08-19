import type {
  AuthStatus,
  ModelProviderInfo,
  OpenHarnessClient,
  ProviderInfo,
} from "@openharness/client"

import type {
  ActivateDesktopProviderInput,
  ConnectDesktopProviderInput,
  DesktopProviderCredentialSource,
  DesktopProviderInfo,
  DesktopProviderSnapshot,
  DisconnectDesktopProviderInput,
} from "../../../shared/provider-types"
import { desktopSessionService } from "../session/session-service"

const CODEX_DEFAULT_MODEL = "gpt-5.6-sol"

export class DesktopProviderService {
  snapshot(): Promise<DesktopProviderSnapshot> {
    return withDaemonRetry(async (client) => {
      const [providers, auth, settings, models] = await Promise.all([
        client.listProviders(),
        client.getAuthStatus(),
        client.getSettings(),
        client.listModels().catch(() => []),
      ])
      return buildDesktopProviderSnapshot({ providers, auth, settings, models })
    })
  }

  async connect(input: ConnectDesktopProviderInput): Promise<DesktopProviderSnapshot> {
    const provider = normalizeProviderName(input.provider)
    const apiKey = input.apiKey.trim()
    if (!provider) throw new Error("请选择要连接的供应商。")
    if (!apiKey) throw new Error("请输入 API 密钥。")

    await withDaemonRetry((client) => client.authLogin({ provider, apiKey }))
    if (input.setActive) await this.activate({ provider })
    return await this.snapshot()
  }

  async activate(input: ActivateDesktopProviderInput): Promise<DesktopProviderSnapshot> {
    const provider = normalizeProviderName(input.provider)
    if (!provider) throw new Error("请选择要使用的供应商。")

    await withDaemonRetry(async (client) => {
      const [settings, providerModels] = await Promise.all([
        client.getSettings(),
        client.listModels().catch(() => []),
      ])
      const currentModel = typeof settings.model === "string" ? settings.model : undefined
      const models = providerModels.find((item) => item.name === provider)?.models ?? []
      const requestedModel = input.model?.trim()
      const model =
        requestedModel ||
        (currentModel && models.some((item) => item.id === currentModel)
          ? currentModel
          : models[0]?.id) ||
        (provider === "codex" ? CODEX_DEFAULT_MODEL : undefined)

      await client.patchSettings({
        provider,
        ...(model ? { model } : {}),
      })
    })
    return await this.snapshot()
  }

  async disconnect(input: DisconnectDesktopProviderInput): Promise<DesktopProviderSnapshot> {
    const provider = normalizeProviderName(input.provider)
    if (!provider) throw new Error("请选择要断开的供应商。")

    await withDaemonRetry(async (client) => {
      const settings = await client.getSettings()
      if (settings.provider === provider) {
        throw new Error("该供应商正在使用中。请先切换到其他供应商，再断开连接。")
      }
      await client.authLogout({ provider })
    })
    return await this.snapshot()
  }
}

export const desktopProviderService = new DesktopProviderService()

export function buildDesktopProviderSnapshot(input: {
  providers: ProviderInfo[]
  auth: AuthStatus
  settings: Record<string, unknown>
  models: ModelProviderInfo[]
}): DesktopProviderSnapshot {
  const activeProvider = stringSetting(input.settings.provider)
  const activeModel = stringSetting(input.settings.model)
  const stored = new Set(input.auth.storedProviders)
  const envByProvider = new Map(input.auth.envProviders.map((item) => [item.name, item.envKey]))
  const modelsByProvider = new Map(input.models.map((item) => [item.name, item.models]))

  const providers = input.providers.map((provider): DesktopProviderInfo => {
    const source = resolveCredentialSource(provider, input.auth, stored, envByProvider)
    const models = (modelsByProvider.get(provider.name) ?? []).map((model) => ({
      id: model.id,
      label: model.label,
    }))
    return {
      name: provider.name,
      displayName: provider.displayName,
      connected: source !== "none",
      active: provider.name === activeProvider,
      local: provider.local === true,
      credentialSource: source,
      ...(credentialLabel(source, provider.name, input.auth, envByProvider)
        ? { credentialLabel: credentialLabel(source, provider.name, input.auth, envByProvider) }
        : {}),
      ...(provider.name === activeProvider && activeModel ? { currentModel: activeModel } : {}),
      models,
    }
  })

  return {
    providers,
    ...(activeProvider ? { activeProvider } : {}),
    ...(activeModel ? { activeModel } : {}),
  }
}

function resolveCredentialSource(
  provider: ProviderInfo,
  auth: AuthStatus,
  stored: Set<string>,
  envByProvider: Map<string, string>
): DesktopProviderCredentialSource {
  if (provider.name === "codex") return auth.codex.configured ? "subscription" : "none"
  if (provider.local) return "local"
  if (stored.has(provider.name)) return "credentials"
  if (envByProvider.has(provider.name)) return "environment"
  return provider.hasKey ? "configured" : "none"
}

function credentialLabel(
  source: DesktopProviderCredentialSource,
  providerName: string,
  auth: AuthStatus,
  envByProvider: Map<string, string>
): string | undefined {
  if (source === "credentials") return "OpenHarness 密钥"
  if (source === "environment") return envByProvider.get(providerName)
  if (source === "subscription") return auth.codex.profileLabel ?? "Codex CLI"
  if (source === "local") return "本地服务"
  if (source === "configured") return "已配置"
  return undefined
}

function normalizeProviderName(value: string): string {
  return value.trim().toLowerCase()
}

function stringSetting(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

async function withDaemonRetry<T>(
  operation: (client: OpenHarnessClient) => Promise<T>
): Promise<T> {
  try {
    return await operation(await desktopSessionService.daemonClient())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (
      !message.includes("Failed to fetch") &&
      !message.includes("ECONNREFUSED") &&
      !message.includes("ECONNRESET")
    ) {
      throw error
    }
    return await operation(await desktopSessionService.refreshDaemonClient())
  }
}
