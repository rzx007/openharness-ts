import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

import { getTeamDir } from "./mailbox.js";

/**
 * 团队磁盘持久化（移植自 Python swarm/team_lifecycle.py）。
 *
 * 团队元数据存为 `~/.openharness/teams/<name>/team.json`，与邮箱共用同一团队
 * 目录——这里建好的目录 TeammateMailbox 直接可用。TS 内部属性 camelCase，
 * 落盘 snake_case（与 Python 互通），读取时 camelCase 容错。
 *
 * 不移植 pane 相关行为（hidden_pane helpers、pane 击杀）：TS 无 tmux/iTerm 后端；
 * pane 字段（tmuxPaneId 等）保留以保 schema 兼容。
 */

// ---------------------------------------------------------------------------
// 名称清洗
// ---------------------------------------------------------------------------

/** 非字母数字 → `-`，再小写（对齐 TS 参考实现 sanitizeName）。 */
export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
}

/** 仅把 `@` 换成 `-`，避免 agentName@teamName 格式歧义。 */
export function sanitizeAgentName(name: string): string {
  return name.replace(/@/g, "-");
}

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

export interface AllowedPath {
  path: string;
  toolName: string;
  addedBy: string;
  addedAt: number;
}

export interface TeamMember {
  agentId: string;
  name: string;
  backendType: string;
  joinedAt: number;
  agentType: string | null;
  model: string | null;
  prompt: string | null;
  color: string | null;
  planModeRequired: boolean;
  sessionId: string | null;
  subscriptions: string[];
  isActive: boolean;
  mode: string | null;
  tmuxPaneId: string;
  cwd: string;
  worktreePath: string | null;
  permissions: string[];
  status: "active" | "idle" | "stopped";
}

export interface TeamFile {
  name: string;
  description: string;
  createdAt: number;
  leadAgentId: string;
  leadSessionId: string | null;
  hiddenPaneIds: string[];
  members: Record<string, TeamMember>;
  teamAllowedPaths: AllowedPath[];
  allowedPaths: string[];
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 序列化：落盘 snake_case，读取 snake 优先 + camel 容错
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;

function pick<T>(data: Raw, snake: string, camel: string, fallback: T): T {
  if (snake in data && data[snake] !== undefined) return data[snake] as T;
  if (camel in data && data[camel] !== undefined) return data[camel] as T;
  return fallback;
}

function memberToRaw(m: TeamMember): Raw {
  return {
    agent_id: m.agentId,
    name: m.name,
    backend_type: m.backendType,
    joined_at: m.joinedAt,
    agent_type: m.agentType,
    model: m.model,
    prompt: m.prompt,
    color: m.color,
    plan_mode_required: m.planModeRequired,
    session_id: m.sessionId,
    subscriptions: m.subscriptions,
    is_active: m.isActive,
    mode: m.mode,
    tmux_pane_id: m.tmuxPaneId,
    cwd: m.cwd,
    worktree_path: m.worktreePath,
    permissions: m.permissions,
    status: m.status,
  };
}

function memberFromRaw(data: Raw): TeamMember {
  return {
    agentId: pick(data, "agent_id", "agentId", ""),
    name: typeof data.name === "string" ? data.name : "",
    backendType: pick(data, "backend_type", "backendType", ""),
    joinedAt: pick(data, "joined_at", "joinedAt", 0),
    agentType: pick<string | null>(data, "agent_type", "agentType", null),
    model: typeof data.model === "string" ? data.model : null,
    prompt: typeof data.prompt === "string" ? data.prompt : null,
    color: typeof data.color === "string" ? data.color : null,
    planModeRequired: pick(data, "plan_mode_required", "planModeRequired", false),
    sessionId: pick<string | null>(data, "session_id", "sessionId", null),
    subscriptions: Array.isArray(data.subscriptions) ? (data.subscriptions as string[]) : [],
    isActive: pick(data, "is_active", "isActive", true),
    mode: typeof data.mode === "string" ? data.mode : null,
    tmuxPaneId: pick(data, "tmux_pane_id", "tmuxPaneId", ""),
    cwd: typeof data.cwd === "string" ? data.cwd : "",
    worktreePath: pick<string | null>(data, "worktree_path", "worktreePath", null),
    permissions: Array.isArray(data.permissions) ? (data.permissions as string[]) : [],
    status: pick(data, "status", "status", "active" as const),
  };
}

function allowedPathToRaw(p: AllowedPath): Raw {
  return { path: p.path, tool_name: p.toolName, added_by: p.addedBy, added_at: p.addedAt };
}

function allowedPathFromRaw(data: Raw): AllowedPath {
  return {
    path: typeof data.path === "string" ? data.path : "",
    toolName: pick(data, "tool_name", "toolName", ""),
    addedBy: pick(data, "added_by", "addedBy", ""),
    addedAt: pick(data, "added_at", "addedAt", 0),
  };
}

function teamFileToRaw(t: TeamFile): Raw {
  return {
    name: t.name,
    description: t.description,
    created_at: t.createdAt,
    lead_agent_id: t.leadAgentId,
    lead_session_id: t.leadSessionId,
    hidden_pane_ids: t.hiddenPaneIds,
    members: Object.fromEntries(Object.entries(t.members).map(([k, v]) => [k, memberToRaw(v)])),
    team_allowed_paths: t.teamAllowedPaths.map(allowedPathToRaw),
    allowed_paths: t.allowedPaths,
    metadata: t.metadata,
  };
}

function teamFileFromRaw(data: Raw): TeamFile {
  const rawMembers = (pick(data, "members", "members", {}) ?? {}) as Record<string, Raw>;
  const rawPaths = pick<Raw[]>(data, "team_allowed_paths", "teamAllowedPaths", []);
  return {
    name: typeof data.name === "string" ? data.name : "",
    description: typeof data.description === "string" ? data.description : "",
    createdAt: pick(data, "created_at", "createdAt", 0),
    leadAgentId: pick(data, "lead_agent_id", "leadAgentId", ""),
    leadSessionId: pick<string | null>(data, "lead_session_id", "leadSessionId", null),
    hiddenPaneIds: pick(data, "hidden_pane_ids", "hiddenPaneIds", []),
    members: Object.fromEntries(
      Object.entries(rawMembers).map(([k, v]) => [k, memberFromRaw(v)]),
    ),
    teamAllowedPaths: Array.isArray(rawPaths) ? rawPaths.map(allowedPathFromRaw) : [],
    allowedPaths: pick(data, "allowed_paths", "allowedPaths", []),
    metadata: pick(data, "metadata", "metadata", {}),
  };
}

// ---------------------------------------------------------------------------
// 读写
// ---------------------------------------------------------------------------

const TEAM_FILE_NAME = "team.json";

export function getTeamFilePath(teamName: string): string {
  return join(getTeamDir(teamName), TEAM_FILE_NAME);
}

export function readTeamFile(teamName: string): TeamFile | null {
  const path = getTeamFilePath(teamName);
  if (!existsSync(path)) return null;
  try {
    return teamFileFromRaw(JSON.parse(readFileSync(path, "utf-8")) as Raw);
  } catch {
    return null;
  }
}

/** `.tmp` + rename 原子写。 */
export function writeTeamFile(teamName: string, teamFile: TeamFile): void {
  const path = getTeamFilePath(teamName);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(teamFileToRaw(teamFile), null, 2), "utf-8");
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// TeamLifecycleManager（无状态：每个方法直接读写盘）
// ---------------------------------------------------------------------------

export class TeamLifecycleManager {
  createTeam(name: string, description = ""): TeamFile {
    const path = getTeamFilePath(name);
    if (existsSync(path)) {
      throw new Error(`Team '${name}' already exists at ${path}`);
    }
    const team: TeamFile = {
      name,
      description,
      createdAt: Date.now() / 1000,
      leadAgentId: "",
      leadSessionId: null,
      hiddenPaneIds: [],
      members: {},
      teamAllowedPaths: [],
      allowedPaths: [],
      metadata: {},
    };
    writeTeamFile(name, team);
    return team;
  }

  deleteTeam(name: string): void {
    const path = getTeamFilePath(name);
    if (!existsSync(path)) {
      throw new Error(`Team '${name}' does not exist`);
    }
    rmSync(dirname(path), { recursive: true, force: true });
  }

  getTeam(name: string): TeamFile | null {
    return readTeamFile(name);
  }

  listTeams(): TeamFile[] {
    const base = join(homedir(), ".openharness", "teams");
    if (!existsSync(base)) return [];
    const teams: TeamFile[] = [];
    for (const entry of readdirSync(base).sort()) {
      const path = join(base, entry, TEAM_FILE_NAME);
      if (!existsSync(path)) continue;
      try {
        teams.push(teamFileFromRaw(JSON.parse(readFileSync(path, "utf-8")) as Raw));
      } catch {
        continue;
      }
    }
    return teams;
  }

  /** 同 agentId 已存在则替换。 */
  addMember(teamName: string, member: TeamMember): TeamFile {
    const team = this.requireTeam(teamName);
    team.members[member.agentId] = member;
    writeTeamFile(teamName, team);
    return team;
  }

  removeMember(teamName: string, agentId: string): TeamFile {
    const team = this.requireTeam(teamName);
    if (!(agentId in team.members)) {
      throw new Error(`Agent '${agentId}' is not a member of team '${teamName}'`);
    }
    delete team.members[agentId];
    writeTeamFile(teamName, team);
    return team;
  }

  setMemberMode(teamName: string, memberName: string, mode: string): boolean {
    return setMemberMode(teamName, memberName, mode);
  }

  async setMemberActive(teamName: string, memberName: string, isActive: boolean): Promise<void> {
    await setMemberActive(teamName, memberName, isActive);
  }

  private requireTeam(name: string): TeamFile {
    const team = readTeamFile(name);
    if (!team) throw new Error(`Team '${name}' does not exist`);
    return team;
  }
}

// ---------------------------------------------------------------------------
// 独立成员管理函数
// ---------------------------------------------------------------------------

export function removeTeammateFromTeamFile(
  teamName: string,
  identifier: { agentId?: string; name?: string },
): boolean {
  const { agentId, name } = identifier;
  if (!agentId && !name) return false;

  const team = readTeamFile(teamName);
  if (!team) return false;

  const toRemove = Object.entries(team.members)
    .filter(([, m]) => (agentId ? m.agentId === agentId : false) || (name ? m.name === name : false))
    .map(([k]) => k);
  if (toRemove.length === 0) return false;

  for (const k of toRemove) delete team.members[k];
  writeTeamFile(teamName, team);
  return true;
}

export function removeMemberByAgentId(teamName: string, agentId: string): boolean {
  const team = readTeamFile(teamName);
  if (!team || !(agentId in team.members)) return false;
  delete team.members[agentId];
  writeTeamFile(teamName, team);
  return true;
}

// ---------------------------------------------------------------------------
// mode / active 同步
// ---------------------------------------------------------------------------

export function setMemberMode(teamName: string, memberName: string, mode: string): boolean {
  const team = readTeamFile(teamName);
  if (!team) return false;

  const entry = Object.entries(team.members).find(([, m]) => m.name === memberName);
  if (!entry) return false;

  const [key, member] = entry;
  if (member.mode === mode) return true;
  team.members[key] = { ...member, mode };
  writeTeamFile(teamName, team);
  return true;
}

/** 批量改 mode，一次原子写。 */
export function setMultipleMemberModes(
  teamName: string,
  modeUpdates: Array<{ memberName: string; mode: string }>,
): boolean {
  const team = readTeamFile(teamName);
  if (!team) return false;

  const updateMap = new Map(modeUpdates.map((u) => [u.memberName, u.mode]));
  let anyChanged = false;
  for (const [key, member] of Object.entries(team.members)) {
    const newMode = updateMap.get(member.name);
    if (newMode !== undefined && member.mode !== newMode) {
      team.members[key] = { ...member, mode: newMode };
      anyChanged = true;
    }
  }
  if (anyChanged) writeTeamFile(teamName, team);
  return true;
}

/** 把当前 agent 的 permission mode 同步进 team.json；env 缺失则 no-op。 */
export function syncTeammateMode(mode: string, teamNameOverride?: string): void {
  const teamName = teamNameOverride ?? process.env.CLAUDE_CODE_TEAM_NAME;
  const agentName = process.env.CLAUDE_CODE_AGENT_NAME;
  if (teamName && agentName) {
    setMemberMode(teamName, agentName, mode);
  }
}

export async function setMemberActive(
  teamName: string,
  memberName: string,
  isActive: boolean,
): Promise<void> {
  const team = readTeamFile(teamName);
  if (!team) return;

  const entry = Object.entries(team.members).find(([, m]) => m.name === memberName);
  if (!entry) return;

  const [key, member] = entry;
  if (member.isActive === isActive) return;
  team.members[key] = { ...member, isActive };
  writeTeamFile(teamName, team);
}

// ---------------------------------------------------------------------------
// teammate 落盘登记（spawn 接线用）
// ---------------------------------------------------------------------------

/**
 * 把一个 teammate 登记进 team.json：团队不存在则创建（并登记会话清理——
 * 本会话隐式建的团队随 leader 退出删除）；同 agentId 重复登记为替换。
 */
export function registerTeammateInTeamFile(teamName: string, member: TeamMember): void {
  const manager = new TeamLifecycleManager();
  if (!readTeamFile(teamName)) {
    manager.createTeam(teamName);
    registerTeamForSessionCleanup(teamName);
  }
  manager.addMember(teamName, member);
}

// ---------------------------------------------------------------------------
// 会话清理
// ---------------------------------------------------------------------------

const sessionCreatedTeams = new Set<string>();

/** 本会话建的团队登记进来，leader 退出时统一清理；显式删除后应 unregister 防双清。 */
export function registerTeamForSessionCleanup(teamName: string): void {
  sessionCreatedTeams.add(teamName);
}

export function unregisterTeamForSessionCleanup(teamName: string): void {
  sessionCreatedTeams.delete(teamName);
}

export async function cleanupSessionTeams(): Promise<void> {
  if (sessionCreatedTeams.size === 0) return;
  const teams = [...sessionCreatedTeams];
  await Promise.allSettled(teams.map((t) => cleanupTeamDirectories(t)));
  sessionCreatedTeams.clear();
}

/** 同步版会话清理：进程 `exit` 钩子里不能 await，整条链用同步 I/O。 */
export function cleanupSessionTeamsSync(): void {
  if (sessionCreatedTeams.size === 0) return;
  for (const team of [...sessionCreatedTeams]) {
    try {
      cleanupTeamDirectoriesSync(team);
    } catch {
      // best-effort：退出路径不抛
    }
  }
  sessionCreatedTeams.clear();
}

/**
 * 销毁一个 git worktree：优先从主仓库跑 `git worktree remove --force`，
 * 失败回退递归删除（对齐 Python _destroy_worktree 的 best-effort 语义）。
 */
function destroyWorktreeSync(worktreePath: string): void {
  let mainRepoPath: string | null = null;
  try {
    const content = readFileSync(join(worktreePath, ".git"), "utf-8").trim();
    const match = /^gitdir:\s*(.+)$/.exec(content);
    if (match) {
      // <repo>/.git/worktrees/<slug> → 主仓库根 = gitdir/../../..
      mainRepoPath = join(match[1]!, "..", "..", "..");
    }
  } catch {
    // 没有 .git 文件：不是标准 worktree，直接走 rm 回退
  }

  if (mainRepoPath) {
    try {
      const result = spawnSync("git", ["worktree", "remove", "--force", worktreePath], {
        cwd: mainRepoPath,
        encoding: "utf-8",
        timeout: 30_000,
      });
      if (result.status === 0) return;
      if ((result.stderr ?? "").includes("not a working tree")) return;
    } catch {
      // 回退 rm
    }
  }

  rmSync(worktreePath, { recursive: true, force: true });
}

/** 清理团队目录：先销毁成员 worktree（删团队目录前收集路径），再删团队目录。 */
function cleanupTeamDirectoriesSync(teamName: string): void {
  const team = readTeamFile(teamName);
  const worktreePaths: string[] = [];
  if (team) {
    for (const member of Object.values(team.members)) {
      if (member.worktreePath) worktreePaths.push(member.worktreePath);
    }
  }

  for (const wtPath of worktreePaths) {
    destroyWorktreeSync(wtPath);
  }

  rmSync(getTeamDir(teamName), { recursive: true, force: true });
}

export async function cleanupTeamDirectories(teamName: string): Promise<void> {
  cleanupTeamDirectoriesSync(teamName);
}
