export interface DaemonOperationScope {
  sessionId: string;
  cwd: string;
}

export type DaemonOperationBarrier =
  | { kind: "global" }
  | { kind: "cwd"; cwd: string }
  | { kind: "session"; sessionId: string; cwd: string };

export interface DaemonOperationLease {
  release(): void;
}

export class DaemonOperationUnavailableError extends Error {
  constructor(readonly reason: "closing" | "blocked") {
    super(reason === "closing" ? "Daemon is closing" : "Daemon operation is blocked by maintenance");
    this.name = "DaemonOperationUnavailableError";
  }
}

type BarrierRecord = DaemonOperationBarrier & { token: symbol };
type SharedRecord = DaemonOperationScope & { token: symbol };

/** Linearizes normal runtime access with session/cwd/global maintenance and shutdown. */
export class DaemonOperationGate {
  private phase: "open" | "closing" | "closed" = "open";
  private readonly shared = new Map<symbol, SharedRecord>();
  private readonly barriers = new Map<symbol, BarrierRecord>();
  private readonly drainWaiters = new Set<() => void>();

  get accepting(): boolean {
    return this.phase === "open";
  }

  enter(scope: DaemonOperationScope): DaemonOperationLease {
    if (this.phase !== "open") throw new DaemonOperationUnavailableError("closing");
    if ([...this.barriers.values()].some((barrier) => conflictsWithScope(barrier, scope))) {
      throw new DaemonOperationUnavailableError("blocked");
    }
    const token = Symbol("daemon-operation");
    this.shared.set(token, { token, ...scope });
    return this.lease(() => this.shared.delete(token));
  }

  tryEnterBarrier(barrier: DaemonOperationBarrier, isIdle: () => boolean): DaemonOperationLease | undefined {
    if (this.phase !== "open") return undefined;
    if ([...this.shared.values()].some((scope) => conflictsWithScope(barrier, scope))) return undefined;
    if ([...this.barriers.values()].some((active) => barriersConflict(barrier, active))) return undefined;
    if (!isIdle()) return undefined;
    const token = Symbol(`daemon-${barrier.kind}-barrier`);
    this.barriers.set(token, { token, ...barrier });
    return this.lease(() => this.barriers.delete(token));
  }

  async beginShutdown(): Promise<void> {
    if (this.phase === "closed") return;
    this.phase = "closing";
    if (this.shared.size === 0 && this.barriers.size === 0) return;
    await new Promise<void>((resolve) => this.drainWaiters.add(resolve));
  }

  markClosed(): void {
    this.phase = "closed";
    this.resolveDrainWaiters();
  }

  private lease(release: () => boolean): DaemonOperationLease {
    let active = true;
    return {
      release: () => {
        if (!active) return;
        active = false;
        release();
        this.resolveDrainWaiters();
      },
    };
  }

  private resolveDrainWaiters(): void {
    if (this.shared.size > 0 || this.barriers.size > 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }
}

function conflictsWithScope(barrier: DaemonOperationBarrier, scope: DaemonOperationScope): boolean {
  if (barrier.kind === "global") return true;
  if (barrier.kind === "cwd") return barrier.cwd === scope.cwd;
  return barrier.sessionId === scope.sessionId;
}

function barriersConflict(left: DaemonOperationBarrier, right: DaemonOperationBarrier): boolean {
  if (left.kind === "global" || right.kind === "global") return true;
  if (left.kind === "cwd" && right.kind === "cwd") return left.cwd === right.cwd;
  if (left.kind === "session" && right.kind === "session") return left.sessionId === right.sessionId;
  const cwd = left.kind === "cwd" ? left.cwd : right.kind === "cwd" ? right.cwd : undefined;
  const session = left.kind === "session" ? left : right.kind === "session" ? right : undefined;
  return !!cwd && !!session && cwd === session.cwd;
}
