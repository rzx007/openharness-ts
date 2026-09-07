import { createHash } from "node:crypto";

import { getSkillsDir, type Settings } from "@openharness/core";
import {
  createWorkspaceBinding,
  type ExecutionEnvironmentConsumer,
  type ExecutionEnvironmentDaemonIdentity,
  type ExecutionEnvironmentLease,
} from "@openharness/environment";
import type { SessionRecord } from "@openharness/protocol";
import {
  createDesktopManagedMounts,
  createExecutionEnvironment,
  acquireSandboxSessionAlias,
  dockerSandboxConfigHash,
  type ExecutionEnvironmentManager,
  resolveExecutionEnvironmentConfig,
} from "@openharness/sandbox";
import { createEnvironmentFileSystem } from "@openharness/tools";

import { resolveEnvironmentOwner } from "./environment-owner.js";

export function createSessionEnvironmentAcquirer(input: {
  manager: ExecutionEnvironmentManager;
  store: { getSession(id: string): SessionRecord | undefined };
  daemonIdentity: ExecutionEnvironmentDaemonIdentity;
}) {
  return async (
    session: SessionRecord,
    settings: Settings,
    consumer: ExecutionEnvironmentConsumer = { kind: "agent", id: session.id },
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

    const lease = await input.manager.acquire({
      ownerId: owner.ownerId,
      configHash,
      daemonIdentity: input.daemonIdentity,
      consumer,
      create: async (identity) => {
        const base = await createExecutionEnvironment({
          config,
          settings,
          binding,
          sessionId: owner.rootSessionId,
          userSkillsRoot: skillsRoot,
          identity,
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
    if (lease.info?.kind !== "docker" || session.id === owner.rootSessionId) return lease;
    const releaseAlias = acquireSandboxSessionAlias({
      cwd: owner.hostRoot,
      sourceSessionId: owner.rootSessionId,
      targetSessionId: session.id,
    });
    let released = false;
    return {
      ...lease,
      release: async () => {
        if (released) return;
        released = true;
        releaseAlias();
        await lease.release();
      },
    };
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
