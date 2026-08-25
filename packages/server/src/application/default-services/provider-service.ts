import {
  PROVIDERS,
  findByName,
} from "@openharness/api";
import { CredentialStorage } from "@openharness/auth";
import type { CustomProviderSettings, Settings } from "@openharness/core";

import { ApplicationError } from "../../shared/application-error.js";
import type {
  CustomProviderInput,
  ProviderInfo,
  ProviderService,
} from "../settings-api.js";
import { validateProviderCredential } from "./credential-validation.js";
import {
  readCurrentSettings,
  saveSettingsAndRefreshRef,
  type DaemonSettingsRef,
} from "./shared.js";

export function createDefaultProviderService(ref: DaemonSettingsRef): ProviderService {
  const storage = new CredentialStorage();
  const rowForCustomProvider = async (
    provider: CustomProviderSettings,
    currentName: string,
  ): Promise<ProviderInfo> => ({
    name: provider.id,
    displayName: provider.displayName,
    hasKey: !!(await storage.loadApiKey(provider.id)),
    active: provider.id === currentName,
    local: false,
    custom: true,
    requiresApiKey: false,
  });

  const saveCustomProviders = async (
    providers: CustomProviderSettings[],
    patch: Partial<Settings> = {},
  ): Promise<void> => {
    const next = { ...ref.current, ...patch, customProviders: providers };
    await saveSettingsAndRefreshRef(ref, next);
  };

  return {
    async list() {
      const current = await readCurrentSettings(ref);
      const currentName = current.provider ?? "auto";
      const rows: ProviderInfo[] = [];
      for (const spec of PROVIDERS) {
        const storedKey = await storage.loadApiKey(spec.name);
        const hasKey = !!storedKey || (spec.envKey ? !!process.env[spec.envKey] : false);
        rows.push({
          name: spec.name,
          displayName: spec.displayName,
          hasKey: !!hasKey || !spec.envKey,
          active: spec.name === currentName,
          local: spec.isLocal,
        });
      }
      for (const provider of current.customProviders ?? []) {
        rows.push(await rowForCustomProvider(provider, currentName));
      }
      return rows;
    },
    async create(input) {
      const current = await readCurrentSettings(ref);
      const provider = normalizeCustomProvider(input);
      if (findByName(provider.id)) {
        throw new ProviderMutationError(400, `供应商 ID “${provider.id}” 已被内置供应商使用。`);
      }
      if (current.customProviders?.some((item) => item.id === provider.id)) {
        throw new ProviderMutationError(409, `自定义供应商 “${provider.id}” 已存在。`);
      }
      if (input.apiKey?.trim()) {
        await validateProviderCredential({
          providerName: provider.id,
          providerDisplayName: provider.displayName,
          backendType: "openai_compat",
          apiKey: input.apiKey.trim(),
          baseUrl: provider.baseUrl,
          headers: provider.headers,
        });
      }
      await saveCustomProviders([...(current.customProviders ?? []), provider]);
      if (input.apiKey?.trim()) await storage.storeApiKey(provider.id, input.apiKey.trim());
      return await rowForCustomProvider(provider, current.provider ?? "auto");
    },
    async update(id, input) {
      const current = await readCurrentSettings(ref);
      const normalizedId = id.trim().toLowerCase();
      const index = current.customProviders?.findIndex((item) => item.id === normalizedId) ?? -1;
      if (index < 0) throw new ProviderMutationError(404, `自定义供应商 “${normalizedId}” 不存在。`);
      const provider = normalizeCustomProvider({ ...input, id: normalizedId });
      const nextProviders = [...(current.customProviders ?? [])];
      nextProviders[index] = provider;
      if (input.apiKey?.trim()) {
        await validateProviderCredential({
          providerName: provider.id,
          providerDisplayName: provider.displayName,
          backendType: "openai_compat",
          apiKey: input.apiKey.trim(),
          baseUrl: provider.baseUrl,
          headers: provider.headers,
        });
      }
      const currentModelStillAvailable = provider.models.some((model) => model.id === current.model);
      await saveCustomProviders(
        nextProviders,
        current.provider === provider.id && !currentModelStillAvailable
          ? { model: provider.models[0]!.id }
          : {},
      );
      if (input.apiKey?.trim()) await storage.storeApiKey(provider.id, input.apiKey.trim());
      return await rowForCustomProvider(provider, current.provider ?? "auto");
    },
    async remove(id) {
      const current = await readCurrentSettings(ref);
      const normalizedId = id.trim().toLowerCase();
      if (current.provider === normalizedId) {
        throw new ProviderMutationError(409, "该供应商正在使用中。请先切换到其他供应商，再删除。");
      }
      const providers = current.customProviders ?? [];
      if (!providers.some((item) => item.id === normalizedId)) {
        throw new ProviderMutationError(404, `自定义供应商 “${normalizedId}” 不存在。`);
      }
      await saveCustomProviders(providers.filter((item) => item.id !== normalizedId));
      await storage.clearProviderCredentials(normalizedId);
    },
  };
}

export class ProviderMutationError extends ApplicationError {
  constructor(
    status: 400 | 404 | 409,
    message: string,
  ) {
    super(status, message);
  }
}

function normalizeCustomProvider(input: CustomProviderInput): CustomProviderSettings {
  const id = input.id?.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    throw new ProviderMutationError(400, "供应商 ID 只能包含小写字母、数字、连字符或下划线。");
  }
  const displayName = input.displayName?.trim();
  if (!displayName) throw new ProviderMutationError(400, "请输入显示名称。");
  const baseUrl = input.baseUrl?.trim();
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
  } catch {
    throw new ProviderMutationError(400, "基础 URL 必须是有效的 HTTP 或 HTTPS 地址。");
  }
  if (input.apiFormat !== "openai") {
    throw new ProviderMutationError(400, "当前仅支持 OpenAI 兼容接口。");
  }
  if (!Array.isArray(input.models) || input.models.length === 0) {
    throw new ProviderMutationError(400, "请至少添加一个模型。");
  }
  const models = input.models.map((model) => ({
    id: model.id?.trim(),
    displayName: model.displayName?.trim() || model.id?.trim(),
  }));
  if (models.some((model) => !model.id)) {
    throw new ProviderMutationError(400, "模型 ID 不能为空。");
  }
  if (new Set(models.map((model) => model.id)).size !== models.length) {
    throw new ProviderMutationError(400, "模型 ID 不能重复。");
  }
  const headers = Object.fromEntries(
    Object.entries(input.headers ?? {})
      .map(([name, value]) => [name.trim(), value.trim()] as const)
      .filter(([name, value]) => name && value),
  );
  return {
    id,
    displayName,
    baseUrl,
    apiFormat: "openai",
    models,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}
