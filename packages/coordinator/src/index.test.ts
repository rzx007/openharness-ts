import { describe, it, expect } from "vitest";
import {
  Coordinator,
  TeamRegistry,
  getTeamRegistry,
  getBuiltinAgentDefinitions,
  getAgentDefinition,
  hasRequiredMcpServers,
} from "./index.js";

describe("Coordinator", () => {
  it("stores config", () => {
    const c = new Coordinator({
      mode: "parallel",
      agents: [{ name: "a", description: "test" }],
    });
    expect(c.getMode()).toBe("parallel");
    expect(c.getAgents()).toHaveLength(1);
  });
});

describe("TeamRegistry", () => {
  it("creates and lists teams", () => {
    const reg = new TeamRegistry();
    const team = reg.createTeam("dev", "Dev team");
    expect(team.name).toBe("dev");
    expect(reg.listTeams()).toHaveLength(1);
  });

  it("rejects duplicate team", () => {
    const reg = new TeamRegistry();
    reg.createTeam("t1");
    expect(() => reg.createTeam("t1")).toThrow("already exists");
  });

  it("deletes a team", () => {
    const reg = new TeamRegistry();
    reg.createTeam("t1");
    reg.deleteTeam("t1");
    expect(reg.listTeams()).toHaveLength(0);
  });

  it("throws deleting nonexistent team", () => {
    const reg = new TeamRegistry();
    expect(() => reg.deleteTeam("nope")).toThrow("does not exist");
  });

  it("adds agents to team", () => {
    const reg = new TeamRegistry();
    reg.createTeam("team");
    reg.addAgent("team", "task-1");
    reg.addAgent("team", "task-1");
    expect(reg.listTeams()[0]!.agents).toEqual(["task-1"]);
  });

  it("sends messages to team", () => {
    const reg = new TeamRegistry();
    reg.createTeam("team");
    reg.sendMessage("team", "hello");
    expect(reg.listTeams()[0]!.messages).toEqual(["hello"]);
  });

  it("lists teams sorted by name", () => {
    const reg = new TeamRegistry();
    reg.createTeam("beta");
    reg.createTeam("alpha");
    expect(reg.listTeams().map((t) => t.name)).toEqual(["alpha", "beta"]);
  });
});

describe("getTeamRegistry", () => {
  it("returns a singleton", () => {
    const a = getTeamRegistry();
    const b = getTeamRegistry();
    expect(a).toBe(b);
  });
});

describe("AgentDefinitions", () => {
  it("has built-in agents", () => {
    const agents = getBuiltinAgentDefinitions();
    expect(agents.length).toBeGreaterThanOrEqual(4);
    const names = agents.map((a) => a.name);
    expect(names).toContain("general-purpose");
    expect(names).toContain("Explore");
    expect(names).toContain("Plan");
    expect(names).toContain("worker");
  });

  it("finds agent by name", () => {
    const agent = getAgentDefinition("Explore");
    expect(agent).toBeDefined();
    expect(agent!.systemPrompt).toContain("READ-ONLY");
  });

  it("returns undefined for unknown agent", () => {
    expect(getAgentDefinition("nonexistent")).toBeUndefined();
  });

  it("has required MCP servers check", () => {
    const agent = { name: "x", description: "", requiredMcpServers: ["github"] };
    expect(hasRequiredMcpServers(agent, ["github-copilot"])).toBe(true);
    expect(hasRequiredMcpServers(agent, ["other"])).toBe(false);
    expect(hasRequiredMcpServers({ name: "y", description: "" }, [])).toBe(true);
  });
});
