import { loadSettings } from "@openharness/core";

import {
  createDefaultAgentPersonaService,
  createDefaultAuthService,
  createDefaultContextService,
  createDefaultDreamService,
  createDefaultGitService,
  createDefaultHooksService,
  createDefaultMemoryService,
  createDefaultOutputStyleService,
  createDefaultPluginService,
  createDefaultProfileService,
  createDefaultProjectInitService,
  createDefaultProviderService,
  createDefaultSettingsService,
  type DaemonSettingsRef,
} from "./default-application-services.js";
import { createDefaultCommandCatalog } from "./default-command-catalog.js";
import {
  startOpenHarnessServer,
  type OpenHarnessServerOptions,
} from "./http.js";

export type OpenHarnessDaemonOptions = Pick<
  OpenHarnessServerOptions,
  "allowedOrigins" | "host" | "logger" | "port" | "store" | "storePath" | "token" | "version"
>;

/** Starts the opinionated daemon application with all standard resource services installed. */
export async function startOpenHarnessDaemon(options: OpenHarnessDaemonOptions = {}) {
  const settingsRef: DaemonSettingsRef = { current: await loadSettings({}) };
  return await startOpenHarnessServer({
    ...options,
    settings: settingsRef.current,
    getSettings: () => settingsRef.current,
    commandCatalog: createDefaultCommandCatalog(() => settingsRef.current),
    settingsService: createDefaultSettingsService(settingsRef),
    providerService: createDefaultProviderService(settingsRef),
    memoryService: createDefaultMemoryService(),
    authService: createDefaultAuthService(),
    contextService: createDefaultContextService(settingsRef),
    dreamService: createDefaultDreamService(settingsRef),
    profileService: createDefaultProfileService(),
    outputStyleService: createDefaultOutputStyleService(),
    projectInitService: createDefaultProjectInitService(),
    pluginService: createDefaultPluginService(settingsRef),
    agentPersonaService: createDefaultAgentPersonaService(),
    hooksService: createDefaultHooksService(settingsRef),
    gitService: createDefaultGitService(),
  });
}
