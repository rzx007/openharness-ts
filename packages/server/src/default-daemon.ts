import { loadSettings } from "@openharness/core";

import {
  createDefaultApplicationServices,
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
  const settingsRef: DaemonSettingsRef = {
    current: await loadSettings({}),
    async reload() {
      return await loadSettings({});
    },
  };
  return await startOpenHarnessServer({
    ...options,
    settings: settingsRef.current,
    getSettings: () => settingsRef.current,
    getSettingsForCwd: async (cwd) => await loadSettings(undefined, {
      includeProject: true,
      projectRoot: cwd,
    }),
    services: {
      commandCatalog: createDefaultCommandCatalog(() => settingsRef.current),
      ...createDefaultApplicationServices(settingsRef),
    },
  });
}
