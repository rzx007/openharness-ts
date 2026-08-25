import type {
  ModelsDevCatalog,
  ModelsDevModel,
  ModelsDevProvider,
} from "./catalog";

const SUPPORTED_OPENAI_PACKAGES = new Set([
  "@ai-sdk/openai",
  "@ai-sdk/openai-compatible",
]);
const CREDENTIAL_ENV_PATTERN = /(?:API_KEY|TOKEN)$/i;

export interface DirectApiKeyCatalogProvider {
  catalogId: string;
  id: string;
  displayName: string;
  baseUrl: string;
  envKey: string;
  models: Array<{ id: string; displayName: string }>;
}

export function listDirectApiKeyCatalogProviders(
  catalog: ModelsDevCatalog,
): DirectApiKeyCatalogProvider[] {
  return Object.entries(catalog)
    .flatMap(([catalogId, provider]) => {
      const normalized = toDirectApiKeyProvider(catalogId, provider);
      return normalized ? [normalized] : [];
    })
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export function toDirectApiKeyProvider(
  catalogId: string,
  provider: ModelsDevProvider,
): DirectApiKeyCatalogProvider | undefined {
  const id = (provider.id?.trim() || catalogId.trim()).toLowerCase();
  const baseUrl = concreteHttpUrl(provider.api);
  const env = provider.env?.filter((item) => item.trim()) ?? [];
  if (
    !/^[a-z0-9][a-z0-9_-]*$/.test(id) ||
    !baseUrl ||
    env.length !== 1 ||
    !CREDENTIAL_ENV_PATTERN.test(env[0]!) ||
    !provider.npm ||
    !SUPPORTED_OPENAI_PACKAGES.has(provider.npm)
  ) {
    return undefined;
  }

  const models = Object.entries(provider.models ?? {})
    .filter(([, model]) => isSelectableModel(model))
    .map(([modelId, model]) => ({
      id: model.id?.trim() || modelId,
      displayName: model.name?.trim() || model.id?.trim() || modelId,
    }));
  if (models.length === 0) return undefined;

  return {
    catalogId,
    id,
    displayName: provider.name?.trim() || id,
    baseUrl,
    envKey: env[0]!,
    models,
  };
}

function concreteHttpUrl(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate || candidate.includes("${")) return undefined;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return undefined;
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
      return undefined;
    return candidate.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function isSelectableModel(model: ModelsDevModel): boolean {
  return model.status !== "deprecated" && model.status !== "alpha";
}
