import type { SessionRecord } from "@openharness/protocol";

export interface ResolvedEnvironmentOwner {
  ownerId: string;
  hostRoot: string;
  rootSessionId: string;
}

export function resolveEnvironmentOwner(
  session: SessionRecord,
  store: { getSession(id: string): SessionRecord | undefined },
  options: { reuseContainer: boolean },
): ResolvedEnvironmentOwner {
  let root = session;
  let isolatedWorkspace = false;
  const visited = new Set([session.id]);

  while (root.parentId) {
    const parent = store.getSession(root.parentId);
    if (!parent || visited.has(parent.id)) break;
    visited.add(parent.id);
    if (!sameWorkspace(parent.cwd, root.cwd)) {
      isolatedWorkspace = true;
      break;
    }
    root = parent;
  }

  if (isolatedWorkspace) {
    return {
      ownerId: `workspace:${normalizeOwnerPath(session.cwd)}`,
      hostRoot: session.cwd,
      rootSessionId: session.id,
    };
  }
  if (session.projectId && options.reuseContainer) {
    return {
      ownerId: `project:${normalizeOwnerPath(session.cwd)}`,
      hostRoot: session.cwd,
      rootSessionId: root.id,
    };
  }
  return {
    ownerId: `session:${root.id}`,
    hostRoot: root.cwd,
    rootSessionId: root.id,
  };
}

export function normalizeOwnerPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function sameWorkspace(left: string, right: string): boolean {
  return normalizeOwnerPath(left) === normalizeOwnerPath(right);
}
