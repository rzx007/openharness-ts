import type {
  AgentPersonaService,
} from "./settings-api.js";
import {
  createDefaultAuthService,
  createDefaultContextService,
  createDefaultDreamService,
  createDefaultGitService,
  createDefaultHooksService,
  createDefaultMemoryService,
  createDefaultModelService,
  createDefaultOutputStyleService,
  createDefaultPluginService,
  createDefaultAgentIdentityService,
  createDefaultProjectInitService,
  createDefaultProviderService,
  createDefaultSettingsService,
  type DaemonSettingsRef,
} from "./default-services/index.js";

export type { DaemonSettingsRef } from "./default-services/index.js";
export {
  createDefaultSettingsService,
  createDefaultProviderService,
  createDefaultModelService,
  createDefaultAuthService,
  createDefaultMemoryService,
  createDefaultContextService,
  createDefaultDreamService,
  createDefaultAgentIdentityService,
  createDefaultOutputStyleService,
  createDefaultProjectInitService,
  createDefaultPluginService,
  createDefaultHooksService,
  createDefaultGitService,
};

export function createDefaultAgentPersonaService(): AgentPersonaService {
  return {
    async list() {
      const { getAllAgentDefinitions } = await import("@openharness/coordinator");
      const agents = getAllAgentDefinitions([]);
      return {
        agents: agents.map((agent) => ({
          name: agent.name,
          description: agent.description,
          ...(agent.source ? { source: agent.source } : {}),
          ...(agent.model ? { model: agent.model } : {}),
        })),
      };
    },
  };
}

/** Complete resource-service set installed by the opinionated daemon application. */
export function createDefaultApplicationServices(ref: DaemonSettingsRef) {
  return {
    settings: createDefaultSettingsService(ref),
    provider: createDefaultProviderService(ref),
    model: createDefaultModelService(ref),
    memory: createDefaultMemoryService(),
    auth: createDefaultAuthService(),
    agentIdentity: createDefaultAgentIdentityService(),
    outputStyle: createDefaultOutputStyleService(),
    projectInit: createDefaultProjectInitService(),
    plugin: createDefaultPluginService(ref),
    agentPersona: createDefaultAgentPersonaService(),
    hooks: createDefaultHooksService(ref),
    git: createDefaultGitService(),
  };
}
