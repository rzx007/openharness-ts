import type {
  ModelsDevModel,
  ProviderInputCapabilities,
} from "@openharness/api";
import type {
  InputSupport,
  ModelInputCapabilities,
} from "@openharness/core";

export function modelInputCapabilities(
  model: Pick<ModelsDevModel, "id" | "modalities">,
): ModelInputCapabilities {
  const inputs = model.modalities?.input;
  if (!inputs) return { image: "unknown" };
  return { image: inputs.includes("image") ? "native" : "unsupported" };
}

export function normalizeInputSupport(value: unknown): InputSupport {
  return value === "native" || value === "unsupported" ? value : "unknown";
}

export function resolveEffectiveImageSupport(
  model: ModelInputCapabilities,
  provider: ProviderInputCapabilities,
): InputSupport {
  if (model.image === "unsupported" || provider.image === "unsupported") {
    return "unsupported";
  }
  if (model.image === "unknown" || provider.image === "unknown") {
    return "unknown";
  }
  return "native";
}
