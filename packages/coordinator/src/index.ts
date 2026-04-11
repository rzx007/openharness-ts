export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt?: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  effort?: string | number;
  permissionMode?: string;
  maxTurns?: number;
  skills?: string[];
  mcpServers?: unknown[];
  hooks?: Record<string, unknown>;
  color?: string;
  background?: boolean;
  initialPrompt?: string;
  memory?: string;
  isolation?: string;
  omitClaudeMd?: boolean;
  criticalSystemReminder?: string;
  requiredMcpServers?: string[];
  filename?: string;
  baseDir?: string;
  source?: "builtin" | "user" | "plugin";
  subagentType?: string;
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

export interface TeamRecord {
  name: string;
  description: string;
  agents: string[];
  messages: string[];
}

export class TeamRegistry {
  private teams = new Map<string, TeamRecord>();

  createTeam(name: string, description = ""): TeamRecord {
    if (this.teams.has(name)) {
      throw new Error(`Team '${name}' already exists`);
    }
    const team: TeamRecord = { name, description, agents: [], messages: [] };
    this.teams.set(name, team);
    return team;
  }

  deleteTeam(name: string): void {
    if (!this.teams.has(name)) {
      throw new Error(`Team '${name}' does not exist`);
    }
    this.teams.delete(name);
  }

  addAgent(teamName: string, taskId: string): void {
    const team = this.requireTeam(teamName);
    if (!team.agents.includes(taskId)) {
      team.agents.push(taskId);
    }
  }

  sendMessage(teamName: string, message: string): void {
    this.requireTeam(teamName).messages.push(message);
  }

  listTeams(): TeamRecord[] {
    return [...this.teams.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private requireTeam(name: string): TeamRecord {
    const team = this.teams.get(name);
    if (!team) throw new Error(`Team '${name}' does not exist`);
    return team;
  }
}

let _defaultTeamRegistry: TeamRegistry | undefined;

export function getTeamRegistry(): TeamRegistry {
  if (!_defaultTeamRegistry) {
    _defaultTeamRegistry = new TeamRegistry();
  }
  return _defaultTeamRegistry;
}

export {
  getBuiltinAgentDefinitions,
  getAgentDefinition,
  getAllAgentDefinitions,
  hasRequiredMcpServers,
} from "./agent-definitions.js";
