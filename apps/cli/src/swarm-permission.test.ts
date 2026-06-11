import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  createPermissionRequest,
  writePermissionRequest,
  readPendingPermissions,
  readResolvedPermission,
  resolvePermission,
} from "@openharness/swarm";
import {
  buildSwarmWorkerPermissionPrompt,
  watchTeamForPermissions,
  pollSwarmPermissionsOnce,
  startSwarmPermissionResolver,
  stopSwarmPermissionResolver,
  _resetSwarmPermissionStateForTests,
} from "./swarm-permission.js";

let team: string;

beforeEach(() => {
  team = `__test_sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  _resetSwarmPermissionStateForTests();
});

afterEach(() => {
  stopSwarmPermissionResolver();
  _resetSwarmPermissionStateForTests();
  rmSync(join(homedir(), ".openharness", "teams", team), { recursive: true, force: true });
  delete process.env.CLAUDE_CODE_TEAM_NAME;
  delete process.env.CLAUDE_CODE_AGENT_ID;
  delete process.env.CLAUDE_CODE_AGENT_NAME;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("buildSwarmWorkerPermissionPrompt (worker side)", () => {
  it("writes a pending request and resolves true when the leader approves", async () => {
    process.env.CLAUDE_CODE_TEAM_NAME = team;
    process.env.CLAUDE_CODE_AGENT_ID = "w@t";
    process.env.CLAUDE_CODE_AGENT_NAME = "w";

    const prompt = buildSwarmWorkerPermissionPrompt({ timeoutMs: 5_000, intervalMs: 25 });
    const decision = prompt("Edit", "needs confirmation", { file_path: "a.ts" });

    // leader 侧：等 pending 出现后批准。
    let pending = await readPendingPermissions(team);
    for (let i = 0; i < 100 && pending.length === 0; i++) {
      await sleep(20);
      pending = await readPendingPermissions(team);
    }
    expect(pending).toHaveLength(1);
    expect(pending[0]!.toolName).toBe("Edit");
    expect(pending[0]!.workerName).toBe("w");

    await resolvePermission(pending[0]!.id, { decision: "approved", resolvedBy: "leader" }, team);
    await expect(decision).resolves.toBe(true);
    // worker 取走后删除 resolved 文件。
    expect(await readResolvedPermission(pending[0]!.id, team)).toBeNull();
  });

  it("resolves false when the leader rejects", async () => {
    process.env.CLAUDE_CODE_TEAM_NAME = team;
    process.env.CLAUDE_CODE_AGENT_ID = "w@t";

    const prompt = buildSwarmWorkerPermissionPrompt({ timeoutMs: 5_000, intervalMs: 25 });
    const decision = prompt("Bash", undefined, { command: "rm -rf /" });

    let pending = await readPendingPermissions(team);
    for (let i = 0; i < 100 && pending.length === 0; i++) {
      await sleep(20);
      pending = await readPendingPermissions(team);
    }
    await resolvePermission(
      pending[0]!.id,
      { decision: "rejected", resolvedBy: "leader", feedback: "no" },
      team,
    );
    await expect(decision).resolves.toBe(false);
  });

  it("times out to false when nobody resolves", async () => {
    process.env.CLAUDE_CODE_TEAM_NAME = team;
    process.env.CLAUDE_CODE_AGENT_ID = "w@t";

    const prompt = buildSwarmWorkerPermissionPrompt({ timeoutMs: 150, intervalMs: 30 });
    await expect(prompt("Edit", undefined, {})).resolves.toBe(false);
  });

  it("returns false immediately without team env (not a swarm worker)", async () => {
    const prompt = buildSwarmWorkerPermissionPrompt({ timeoutMs: 1_000, intervalMs: 25 });
    await expect(prompt("Edit", undefined, {})).resolves.toBe(false);
  });
});

describe("pollSwarmPermissionsOnce (leader side)", () => {
  const checkerOf = (action: "allow" | "deny" | "ask", reason?: string) => ({
    checkTool: () => ({ action, reason }),
  });
  const readOnly = new Set(["Read"]);

  async function writeRequest(toolName: string): Promise<string> {
    const req = createPermissionRequest({
      toolName,
      toolUseId: "tu",
      toolInput: {},
      teamName: team,
      workerId: "w@t",
      workerName: "w",
    });
    await writePermissionRequest(req);
    return req.id;
  }

  it("approves when the leader checker allows, rejects on deny/ask", async () => {
    watchTeamForPermissions(team);

    const allowId = await writeRequest("Edit");
    expect(await pollSwarmPermissionsOnce(checkerOf("allow"), readOnly)).toBe(1);
    expect((await readResolvedPermission(allowId, team))!.status).toBe("approved");

    const denyId = await writeRequest("Bash");
    await pollSwarmPermissionsOnce(checkerOf("deny", "blacklisted"), readOnly);
    const denied = (await readResolvedPermission(denyId, team))!;
    expect(denied.status).toBe("rejected");
    expect(denied.feedback).toBe("blacklisted");
  });

  it("auto-approves read-only tools without the checker", async () => {
    watchTeamForPermissions(team);
    const id = await writeRequest("Read");
    await pollSwarmPermissionsOnce(checkerOf("deny", "never called"), readOnly);
    expect((await readResolvedPermission(id, team))!.status).toBe("approved");
  });

  it("ignores teams that are not watched", async () => {
    const id = await writeRequest("Edit");
    expect(await pollSwarmPermissionsOnce(checkerOf("allow"), readOnly)).toBe(0);
    expect(await readResolvedPermission(id, team)).toBeNull();
  });
});

describe("startSwarmPermissionResolver (interval)", () => {
  it("resolves pending requests in the background until stopped", async () => {
    watchTeamForPermissions(team);
    startSwarmPermissionResolver({ checkTool: () => ({ action: "allow" }) }, new Set(), {
      intervalMs: 30,
    });

    const req = createPermissionRequest({
      toolName: "Edit",
      toolUseId: "tu",
      toolInput: {},
      teamName: team,
      workerId: "w@t",
      workerName: "w",
    });
    await writePermissionRequest(req);

    let resolved = await readResolvedPermission(req.id, team);
    for (let i = 0; i < 100 && !resolved; i++) {
      await sleep(20);
      resolved = await readResolvedPermission(req.id, team);
    }
    expect(resolved!.status).toBe("approved");

    // start 幂等：再次 start 不应抛错或重复定时器。
    startSwarmPermissionResolver({ checkTool: () => ({ action: "allow" }) }, new Set(), {
      intervalMs: 30,
    });
    stopSwarmPermissionResolver();
  });
});
