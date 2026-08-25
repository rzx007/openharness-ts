import type { ModelsDevCatalog, ModelsDevProvider } from "@openharness/api";

const CATALOG_PROVIDER_ALIASES: Record<string, string[]> = {
  bedrock: ["amazon-bedrock"],
  dashscope: ["dashscope", "alibaba"],
  gemini: ["gemini", "google"],
  vertex: ["google-vertex", "vertex"],
  zhipu: ["zhipu", "z-ai"],
};

export function readCatalogProvider(
  catalog: ModelsDevCatalog,
  providerName: string,
): ModelsDevProvider | undefined {
  for (const key of catalogProviderKeys(providerName)) {
    const provider = catalog[key];
    if (provider?.models && Object.keys(provider.models).length > 0) {
      return provider;
    }
  }
  return undefined;
}

export function catalogProviderModelIds(
  catalog: ModelsDevCatalog,
  providerName: string,
): string[] {
  const provider = readCatalogProvider(catalog, providerName);
  if (!provider?.models) return [];
  return Object.entries(provider.models)
    .filter(
      ([, model]) => model.status !== "deprecated" && model.status !== "alpha",
    )
    .map(([id, model]) =>
      typeof model.id === "string" && model.id.trim() ? model.id.trim() : id,
    );
}

function catalogProviderKeys(providerName: string): string[] {
  return [
    providerName,
    ...(CATALOG_PROVIDER_ALIASES[providerName] ?? []),
  ].filter((item, index, items) => item && items.indexOf(item) === index);
}
