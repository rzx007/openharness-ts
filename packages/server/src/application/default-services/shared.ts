import {
  saveSettings,
  type Settings,
} from "@openharness/core";

export interface DaemonSettingsRef {
  current: Settings;
  reload?: () => Promise<Settings> | Settings;
}

export function sanitizeSettings(settings: Settings): Record<string, unknown> {
  const { apiKey: _apiKey, ...rest } = settings as Settings & { apiKey?: string };
  return structuredClone(rest) as Record<string, unknown>;
}

export async function readCurrentSettings(ref: DaemonSettingsRef): Promise<Settings> {
  const loaded = ref.reload ? await ref.reload() : undefined;
  if (loaded) ref.current = loaded;
  return ref.current;
}

export function mergeSettingsPatch(current: Settings, patch: Record<string, unknown>): Settings {
  const next: Settings = {
    ...current,
    ...patch,
    permission: {
      ...current.permission,
      ...(isRecord(patch.permission) ? patch.permission : {}),
    },
    context: {
      ...current.context,
      ...(isRecord(patch.context) ? patch.context : {}),
    },
    sessionContinuity: {
      ...current.sessionContinuity,
      ...(isRecord(patch.sessionContinuity) ? patch.sessionContinuity : {}),
    },
    sandbox: {
      ...current.sandbox,
      ...(isRecord(patch.sandbox) ? patch.sandbox : {}),
    },
    daemon: {
      ...current.daemon,
      ...(isRecord(patch.daemon) ? patch.daemon : {}),
    },
    plugins: {
      ...current.plugins,
      ...(isRecord(patch.plugins) ? patch.plugins : {}),
    },
  } as Settings;
  return next;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function saveSettingsAndRefreshRef(
  ref: DaemonSettingsRef,
  next: Settings
): Promise<void> {
  await saveSettings(next);
  ref.current = next;
}
