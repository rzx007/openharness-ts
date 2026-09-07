import { resolve } from "node:path";
import { mkdir, stat } from "node:fs/promises";

export interface ManagedDockerMount {
  purpose: string;
  source: string;
  target: string;
  mode: "ro" | "rw";
}

export function resolveContainerWorkspacePath(
  _hostPath: string,
  _platform: NodeJS.Platform = process.platform,
): string {
  return "/workspace";
}

export function createDesktopManagedMounts(input: {
  workspaceRoot: string;
  userSkillsRoot: string;
}): ManagedDockerMount[] {
  return [
    {
      purpose: "workspace",
      source: resolve(input.workspaceRoot),
      target: "/workspace",
      mode: "rw",
    },
    {
      purpose: "user_skills",
      source: resolve(input.userSkillsRoot),
      target: "/opt/openharness/skills",
      mode: "rw",
    },
  ];
}

export async function prepareDesktopManagedMounts(input: {
  workspaceRoot: string;
  userSkillsRoot: string;
}): Promise<ManagedDockerMount[]> {
  const workspaceRoot = resolve(input.workspaceRoot);
  const workspace = await stat(workspaceRoot).catch(() => undefined);
  if (!workspace?.isDirectory()) {
    throw new Error(`Managed Docker workspace must be a directory: ${workspaceRoot}`);
  }

  const userSkillsRoot = resolve(input.userSkillsRoot);
  await mkdir(userSkillsRoot, { recursive: true });
  const skills = await stat(userSkillsRoot);
  if (!skills.isDirectory()) {
    throw new Error(`Managed Docker Skill root must be a directory: ${userSkillsRoot}`);
  }

  return createDesktopManagedMounts({ workspaceRoot, userSkillsRoot });
}
