export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  model?: string;
  systemPrompt?: string;
  tools?: string[];
}

export type CoordinatorMode = "sequential" | "parallel" | "pipeline";

export interface CoordinatorConfig {
  mode: CoordinatorMode;
  agents: AgentDefinition[];
}

export class Coordinator {
  private config: CoordinatorConfig;

  constructor(config: CoordinatorConfig) {
    this.config = config;
  }

  getAgents(): AgentDefinition[] {
    return this.config.agents;
  }

  getMode(): CoordinatorMode {
    return this.config.mode;
  }
}
