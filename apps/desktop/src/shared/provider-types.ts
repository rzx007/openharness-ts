export type DesktopProviderCredentialSource =
  "credentials" | "environment" | "subscription" | "local" | "configured" | "none"

export interface DesktopProviderModel {
  id: string
  label: string
}

export interface DesktopProviderInfo {
  name: string
  displayName: string
  connected: boolean
  active: boolean
  local: boolean
  credentialSource: DesktopProviderCredentialSource
  credentialLabel?: string
  currentModel?: string
  models: DesktopProviderModel[]
}

export interface DesktopProviderSnapshot {
  providers: DesktopProviderInfo[]
  activeProvider?: string
  activeModel?: string
}

export interface ConnectDesktopProviderInput {
  provider: string
  apiKey: string
  setActive?: boolean
}

export interface ActivateDesktopProviderInput {
  provider: string
  model?: string
}

export interface DisconnectDesktopProviderInput {
  provider: string
}
