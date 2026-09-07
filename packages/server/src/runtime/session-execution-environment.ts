import { createHash } from "node:crypto";

import { getSkillsDir, type Settings } from "@openharness/core";
import { createWorkspaceBinding, type ExecutionEnvironmentLease } from "@openharness/environment";
import type { SessionRecord } from "@openharness/protocol";
import {
  createDesktopManagedMounts,
  createExecutionEnvironment,
  dockerSandboxConfigHash,
  type ExecutionEnvironmentManager,
  resolveExecutionEnvironmentConfig,
} from "@openharness/sandbox";
import { createEnvironmentFileSystem } from "@openharness/tools";

import { resolveEnvironmentOwner } from "./environment-owner.js";

export function createSessionEnvironmentAcquirer(input: {
  manager: ExecutionEnvironmentManager;
  store: { getSession(id: string): SessionRecord | undefined };
}) {
  return async (
    session: SessionRecord,
    settings: Settings,
  ): Promise<ExecutionEnvironmentLease> => {
    const config = resolveExecutionEnvironmentConfig({
      surface: "desktop_managed",
      settings,
      cwd: session.cwd,
    });
    const owner = resolveEnvironmentOwner(session, input.store, {
      reuseContainer: config.kind === "docker" && config.sandbox.docker.reuseContainer,
    });
    const binding = createWorkspaceBinding({
      kind: config.kind,
      hostRoot: owner.hostRoot,
      executionRoot: config.kind === "docker" ? "/workspace" : owner.hostRoot,
    });
    const skillsRoot = getSkillsDir();
    const configHash = environmentConfigHash(config, owner.hostRoot, skillsRoot, settings);

    return input.manager.acquire({
      ownerId: owner.ownerId,
      configHash,
      consumer: { kind: "agent", id: session.id },
      create: async () => {
        const base = await createExecutionEnvironment({
          config,
          settings,
          binding,
          sessionId: owner.rootSessionId,
          userSkillsRoot: skillsRoot,
        });
        return {
          ...base,
          files: createEnvironmentFileSystem(base, {
            settings,
            sessionId: owner.rootSessionId,
          }),
        };
      },
    });
  };
}

function environmentConfigHash(
  config: ReturnType<typeof resolveExecutionEnvironmentConfig>,
  hostRoot: string,
  skillsRoot: string,
  settings: Settings,
): string {
  const base = config.kind === "docker"
    ? dockerSandboxConfigHash(
        config.sandbox,
        hostRoot,
        createDesktopManagedMounts({ workspaceRoot: hostRoot, userSkillsRoot: skillsRoot }),
      )
    : `local:${hostRoot}`;
  return createHash("sha256")
    .update(JSON.stringify({ base, terminal: settings.terminal ?? {} }))
    .digest("hex")
    .slice(0, 16);
}
