import type { Message } from "@openharness/core";

export interface TeamMember {
  id: string;
  name: string;
  role: string;
  capabilities?: string[];
}

export interface SwarmMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface Team {
  id: string;
  name: string;
  members: Map<string, TeamMember>;
  createdAt: number;
}

export class TeamRegistry {
  private teams = new Map<string, Team>();

  register(teamId: string, name: string): Team {
    if (this.teams.has(teamId)) {
      throw new Error(`Team already registered: ${teamId}`);
    }
    const team: Team = {
      id: teamId,
      name,
      members: new Map(),
      createdAt: Date.now(),
    };
    this.teams.set(teamId, team);
    return team;
  }

  unregister(teamId: string): void {
    this.teams.delete(teamId);
  }

  get(teamId: string): Team | undefined {
    return this.teams.get(teamId);
  }

  getAll(): readonly Team[] {
    return [...this.teams.values()];
  }

  addMember(teamId: string, member: TeamMember): void {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    team.members.set(member.id, member);
  }

  removeMember(teamId: string, memberId: string): void {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    team.members.delete(memberId);
  }
}

export class Mailbox {
  private queues = new Map<string, SwarmMessage[]>();

  send(message: SwarmMessage): void {
    const queue = this.queues.get(message.to);
    if (queue) {
      queue.push(message);
    } else {
      this.queues.set(message.to, [message]);
    }
  }

  receive(agentId: string): SwarmMessage[] {
    const messages = this.queues.get(agentId) ?? [];
    this.queues.set(agentId, []);
    return messages;
  }

  peek(agentId: string): readonly SwarmMessage[] {
    return this.queues.get(agentId) ?? [];
  }

  hasMessages(agentId: string): boolean {
    return (this.queues.get(agentId)?.length ?? 0) > 0;
  }

  clear(agentId: string): void {
    this.queues.delete(agentId);
  }

  broadcast(
    from: string,
    recipientIds: string[],
    content: string
  ): SwarmMessage[] {
    const timestamp = Date.now();
    return recipientIds.map((to, i) => {
      const msg: SwarmMessage = {
        id: `msg_${timestamp}_${i}`,
        from,
        to,
        content,
        timestamp,
      };
      this.send(msg);
      return msg;
    });
  }
}
