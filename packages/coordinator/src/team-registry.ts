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
