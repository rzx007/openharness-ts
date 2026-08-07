import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import { getConfigDir, resolveGitRepository } from "@openharness/core";

import type {
  ChildAgentInput,
  ChildAgentInvocation,
  ChildAgentResult,
  ChildAgentSpawnInput,
  RuntimeChildAgentHost,
  RuntimeHostScope,
} from "../runtime-host.js";
import type { ChildSessionHost, SessionTaskBridge } from "../runtime.js";

interface ChildInvocationRecord {
  taskId: string;
  sessionId: string;
  runId?: string;
  generation: number;
  result: Promise<ChildAgentResult>;
  worktreeSlug?: string;
  worktreeManager?: ChildAgentWorktreeManager;
}

interface ChildAgentWorktreeManager {
  isGitRepo(): Promise<boolean>;
  create(slug: string): Promise<{ slug: string; path: string; branch: string; created: boolean }>;
  hasChanges(slug: string): Promise<boolean>;
  remove(slug: string, opts?: { force?: boolean }): Promise<void>;
}

interface GitRunner {
  (args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

interface WorktreeListEntry {
  slug?: string;
  path: string;
  branch?: string;
}

export interface DaemonChildAgentHostContext {
  scope: RuntimeHostScope;
  childSessionHost: ChildSessionHost;
  sessionTaskBridge: SessionTaskBridge;
  createWorktreeManager?: (cwd: string) => Promise<ChildAgentWorktreeManager>;
}

export class DaemonChildAgentHost implements RuntimeChildAgentHost {
  private readonly invocations = new Map<string, ChildInvocationRecord>();

  constructor(private readonly context: DaemonChildAgentHostContext) {}

  async spawnChildAgent(input: ChildAgentSpawnInput): Promise<ChildAgentInvocation> {
    const invocationId = `child_${randomUUID()}`;
    const team = input.team ?? "default";
    let effectiveCwd = input.cwd;
    let worktree: ChildAgentInvocation["worktree"];
    let worktreeSlug: string | undefined;
    let worktreeManager: ChildAgentWorktreeManager | undefined;
    let childSessionId: string | undefined;
    let taskId: string | undefined;

    try {
      if (input.isolate) {
        worktreeManager = await this.createWorktreeManager(input.cwd);
        if (await worktreeManager.isGitRepo()) {
          const rawSlug = `${team}-${input.agent}`
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, "-")
            .replace(/^-+|-+$/g, "") || "agent";
          const suffix = `${createHash("sha1").update(rawSlug).digest("hex").slice(0, 8)}-${randomUUID().slice(0, 8)}`;
          const slug = `${rawSlug.slice(0, 64 - suffix.length - 1)}-${suffix}`;
          const created = await worktreeManager.create(slug);
          effectiveCwd = created.path;
          worktree = { path: created.path, branch: created.branch };
          if (created.created) worktreeSlug = created.slug;
        }
      }

      const child = await this.context.childSessionHost.createChildSession({
        ...(input.sessionId ? { id: input.sessionId } : {}),
        parentId: this.context.scope.sessionId,
        cwd: effectiveCwd,
        ...(input.model ? { model: input.model } : {}),
        title: `${input.agent}@${team}`,
        agent: input.agent,
        metadata: {
          ...input.metadata,
          team,
          systemPrompt: input.systemPrompt,
          permissionMode: input.permissionMode,
          allowedTools: input.allowedTools,
          disallowedTools: input.disallowedTools,
          maxTurns: input.maxTurns,
          effort: input.effort,
          isolate: input.isolate,
          ...(worktree ? { worktree } : {}),
        },
      });
      childSessionId = child.id;

      const task = this.context.sessionTaskBridge.registerSessionTask({
        description: input.description,
        cwd: effectiveCwd,
        sessionId: this.context.scope.sessionId,
        childSessionId: child.id,
        prompt: input.prompt,
        onInput: async (data) => {
          await this.sendToChild(invocationId, data);
        },
        onStop: async () => {
          await this.interruptChildAgent(invocationId, "Child agent stopped");
        },
      });
      taskId = task.id;

      const admitted = await this.context.childSessionHost.admitPrompt(child.id, input.prompt);
      if (admitted.runId) await this.context.sessionTaskBridge.bindSessionTaskRun(task.id, admitted.runId);
      const record: ChildInvocationRecord = {
        taskId: task.id,
        sessionId: child.id,
        ...(admitted.runId ? { runId: admitted.runId } : {}),
        generation: 0,
        result: Promise.resolve({ status: "completed", output: "" }),
        ...(worktreeSlug ? { worktreeSlug } : {}),
        ...(worktreeManager ? { worktreeManager } : {}),
      };
      this.invocations.set(invocationId, record);
      const result = this.monitorRun(record, admitted.runId);
      record.result = result;

      return {
        id: invocationId,
        taskId: task.id,
        sessionId: child.id,
        ...(admitted.runId ? { runId: admitted.runId } : {}),
        result,
        ...(worktree ? { worktree } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (taskId) {
        await this.context.sessionTaskBridge.completeSessionTask(taskId, { status: "failed", output: message }).catch(() => {});
      }
      if (childSessionId) {
        await this.context.childSessionHost.interrupt(childSessionId).catch(() => {});
        await this.context.childSessionHost.closeRuntime(childSessionId).catch(() => {});
        await this.context.childSessionHost.archive(childSessionId).catch(() => {});
      }
      if (worktreeSlug && worktreeManager) {
        await worktreeManager.remove(worktreeSlug, { force: true }).catch(() => {});
      }
      throw error;
    }
  }

  async sendChildInput(invocationId: string, input: ChildAgentInput): Promise<void> {
    const record = this.getInvocation(invocationId);
    await this.context.sessionTaskBridge.writeToSessionTask(record.taskId, input.content);
  }

  async interruptChildAgent(invocationId: string, _reason?: string): Promise<void> {
    const record = this.getInvocation(invocationId);
    record.generation++;
    await this.context.childSessionHost.interrupt(record.sessionId);
    await this.context.childSessionHost.closeRuntime(record.sessionId);
    await this.context.childSessionHost.archive(record.sessionId);
    await this.context.sessionTaskBridge.completeSessionTask(record.taskId, {
      status: "stopped",
      output: "Child agent stopped",
    });
    if (record.worktreeSlug && record.worktreeManager) {
      const hasChanges = await record.worktreeManager.hasChanges(record.worktreeSlug).catch(() => true);
      if (!hasChanges) await record.worktreeManager.remove(record.worktreeSlug).catch(() => {});
    }
    this.invocations.delete(invocationId);
  }

  async awaitChildAgent(invocationId: string): Promise<ChildAgentResult> {
    return await this.getInvocation(invocationId).result;
  }

  private async sendToChild(invocationId: string, content: string): Promise<void> {
    const record = this.getInvocation(invocationId);
    const admitted = await this.context.childSessionHost.admitPrompt(record.sessionId, content);
    if (admitted.runId) {
      record.runId = admitted.runId;
      await this.context.sessionTaskBridge.bindSessionTaskRun(record.taskId, admitted.runId);
      const result = this.monitorRun(record, admitted.runId);
      record.result = result;
    }
  }

  private monitorRun(record: ChildInvocationRecord, runId: string | undefined): Promise<ChildAgentResult> {
    const generation = ++record.generation;
    if (!runId) {
      const result: ChildAgentResult = { status: "completed", output: "" };
      void this.context.sessionTaskBridge.completeSessionTask(record.taskId, result);
      return Promise.resolve(result);
    }

    return this.context.childSessionHost.awaitRun(record.sessionId, runId).then(
      async (result) => {
        if (record.generation !== generation) return result;
        const normalized: ChildAgentResult = {
          status: result.status,
          output: result.output,
          ...(result.error ? { error: result.error } : {}),
        };
        await this.context.sessionTaskBridge.completeSessionTask(record.taskId, normalized);
        await this.context.childSessionHost.closeRuntime(record.sessionId).catch(() => {});
        return normalized;
      },
      async (error) => {
        if (record.generation !== generation) return { status: "failed", output: "", error: "" };
        const message = error instanceof Error ? error.message : String(error);
        const result: ChildAgentResult = { status: "failed", output: message, error: message };
        await this.context.sessionTaskBridge.completeSessionTask(record.taskId, result).catch(() => {});
        await this.context.childSessionHost.closeRuntime(record.sessionId).catch(() => {});
        return result;
      },
    );
  }

  private getInvocation(invocationId: string): ChildInvocationRecord {
    const record = this.invocations.get(invocationId);
    if (!record) throw new Error(`Child agent invocation not found: ${invocationId}`);
    return record;
  }

  private async createWorktreeManager(cwd: string): Promise<ChildAgentWorktreeManager> {
    if (this.context.createWorktreeManager) return await this.context.createWorktreeManager(cwd);
    const repoRoot = resolveGitRepository(cwd)?.root ?? cwd;
    return new WorktreeManager({
      runGit: nodeRunGit,
      repoRoot,
      baseDir: computeWorktreeBaseDir(repoRoot, getConfigDir()),
    });
  }
}

function computeWorktreeBaseDir(repoRoot: string, configDir: string): string {
  const normalized = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  const repoId = createHash("sha1").update(key).digest("hex").slice(0, 12);
  return join(configDir, "worktrees", repoId);
}

const VALID_WORKTREE_SEGMENT = /^[A-Za-z0-9._+-]+$/;
const MAX_WORKTREE_SLUG_LENGTH = 64;

class WorktreeManager implements ChildAgentWorktreeManager {
  constructor(
    private readonly options: {
      runGit: GitRunner;
      baseDir: string;
      repoRoot: string;
    },
  ) {}

  async isGitRepo(): Promise<boolean> {
    const { code, stdout } = await this.options.runGit(
      ["rev-parse", "--is-inside-work-tree"],
      this.options.repoRoot,
    );
    return code === 0 && stdout.trim() === "true";
  }

  async create(slug: string): Promise<{ slug: string; path: string; branch: string; created: boolean }> {
    const normalizedSlug = validateWorktreeSlug(slug);
    const path = join(this.options.baseDir, flattenWorktreeSlug(normalizedSlug));
    const branch = worktreeBranch(normalizedSlug);
    const existing = await this.list();
    if (existing.some((entry) => samePath(entry.path, path))) {
      return { slug: normalizedSlug, path, branch, created: false };
    }
    const { code, stderr } = await this.options.runGit(
      ["worktree", "add", "-B", branch, path, "HEAD"],
      this.options.repoRoot,
    );
    if (code !== 0) throw new Error(`git worktree add failed: ${stderr.trim()}`);
    return { slug: normalizedSlug, path, branch, created: true };
  }

  async hasChanges(slug: string): Promise<boolean> {
    const path = join(this.options.baseDir, flattenWorktreeSlug(validateWorktreeSlug(slug)));
    const { code, stdout } = await this.options.runGit(["status", "--porcelain"], path);
    if (code !== 0) return false;
    return stdout.trim().length > 0;
  }

  async remove(slug: string, opts?: { force?: boolean }): Promise<void> {
    const path = join(this.options.baseDir, flattenWorktreeSlug(validateWorktreeSlug(slug)));
    const args = ["worktree", "remove"];
    if (opts?.force) args.push("--force");
    args.push(path);
    const { code, stderr } = await this.options.runGit(args, this.options.repoRoot);
    if (code !== 0) throw new Error(`git worktree remove failed: ${stderr.trim()}`);
  }

  private async list(): Promise<WorktreeListEntry[]> {
    const { code, stdout } = await this.options.runGit(
      ["worktree", "list", "--porcelain"],
      this.options.repoRoot,
    );
    if (code !== 0) return [];
    return parseWorktreePorcelain(stdout, this.options.baseDir);
  }
}

function validateWorktreeSlug(slug: string): string {
  if (!slug) throw new Error("Worktree slug must not be empty");
  if (slug.length > MAX_WORKTREE_SLUG_LENGTH) {
    throw new Error(`Worktree slug must be ${MAX_WORKTREE_SLUG_LENGTH} characters or fewer`);
  }
  if (slug.startsWith("/") || slug.startsWith("\\")) {
    throw new Error(`Worktree slug must not be an absolute path: ${JSON.stringify(slug)}`);
  }
  for (const segment of slug.split("/")) {
    if (segment === "." || segment === ".." || !VALID_WORKTREE_SEGMENT.test(segment)) {
      throw new Error(`Invalid worktree slug: ${JSON.stringify(slug)}`);
    }
  }
  return slug;
}

function flattenWorktreeSlug(slug: string): string {
  return slug.replace(/\//g, "+");
}

function worktreeBranch(slug: string): string {
  return `worktree-${flattenWorktreeSlug(slug)}`;
}

function parseWorktreePorcelain(stdout: string, baseDir: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | undefined;
  const baseNorm = normalizePath(baseDir);
  const flush = () => {
    if (current) entries.push(current);
    current = undefined;
  };
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      const path = line.slice("worktree ".length).trim();
      current = { path };
      const pathNorm = normalizePath(path);
      if (pathNorm.startsWith(`${baseNorm}/`)) {
        current.slug = pathNorm.slice(baseNorm.length + 1).replace(/\+/g, "/");
      }
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  flush();
  return entries;
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function normalizePath(path: string): string {
  const slashed = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

const nodeRunGit: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("error", (error) => {
      resolve({ code: 127, stdout, stderr: stderr || error.message });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
