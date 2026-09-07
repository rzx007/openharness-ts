import { randomUUID } from "node:crypto";

import type {
  ExecutionEnvironmentConsumer,
  ExecutionEnvironmentDaemonIdentity,
  ExecutionEnvironmentHandle,
  ExecutionEnvironmentIdentity,
  ExecutionEnvironmentLease,
} from "@openharness/environment";

export interface AcquireExecutionEnvironmentRequest {
  ownerId: string;
  configHash: string;
  daemonIdentity: ExecutionEnvironmentDaemonIdentity;
  consumer: ExecutionEnvironmentConsumer;
  create(identity: ExecutionEnvironmentIdentity): Promise<ExecutionEnvironmentHandle>;
}

export interface ExecutionEnvironmentInspection {
  environmentId: string;
  ownerId: string;
  configHash: string;
  state: "preparing" | "ready" | "failed" | "stopped";
  leaseCount: number;
  leaseKinds: ExecutionEnvironmentConsumer["kind"][];
}

interface EnvironmentRecord {
  environmentId: string;
  ownerId: string;
  configHash: string;
  state: ExecutionEnvironmentInspection["state"];
  handle?: ExecutionEnvironmentHandle;
  preparing?: Promise<ExecutionEnvironmentHandle>;
  stopping?: Promise<void>;
  leases: Map<string, ExecutionEnvironmentConsumer>;
}

export class ExecutionEnvironmentManagerError extends Error {
  constructor(
    readonly code: "environment_config_in_use" | "environment_manager_disposed",
    message: string,
  ) {
    super(message);
    this.name = "ExecutionEnvironmentManagerError";
  }
}

export class ExecutionEnvironmentManager {
  private readonly records = new Map<string, EnvironmentRecord>();
  private disposed = false;

  async acquire(request: AcquireExecutionEnvironmentRequest): Promise<ExecutionEnvironmentLease> {
    if (this.disposed) {
      throw new ExecutionEnvironmentManagerError(
        "environment_manager_disposed",
        "Execution environment manager is disposed",
      );
    }

    while (true) {
      let record = this.records.get(request.ownerId);
      if (record?.stopping) {
        await record.stopping;
        continue;
      }
      if (record && record.configHash !== request.configHash) {
        throw new ExecutionEnvironmentManagerError(
          "environment_config_in_use",
          `Environment owner ${request.ownerId} is using another configuration`,
        );
      }
      if (!record) {
        record = this.createRecord(request);
        this.records.set(request.ownerId, record);
      }

      let handle: ExecutionEnvironmentHandle;
      try {
        handle = record.handle ?? await record.preparing!;
      } catch (error) {
        if (this.records.get(request.ownerId) === record) this.records.delete(request.ownerId);
        record.state = "failed";
        throw error;
      }
      if (this.records.get(request.ownerId) !== record || record.stopping) continue;
      record.handle = handle;
      record.preparing = undefined;
      record.state = "ready";

      const leaseId = randomUUID();
      record.leases.set(leaseId, { ...request.consumer });
      return this.createLease(record, handle, leaseId, request.consumer);
    }
  }

  inspect(ownerId: string): ExecutionEnvironmentInspection | undefined {
    const record = this.records.get(ownerId);
    if (!record) return undefined;
    return {
      environmentId: record.environmentId,
      ownerId: record.ownerId,
      configHash: record.configHash,
      state: record.state,
      leaseCount: record.leases.size,
      leaseKinds: [...record.leases.values()].map((consumer) => consumer.kind),
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all([...this.records.values()].map(async (record) => {
      const handle = record.handle ?? await record.preparing?.catch(() => undefined);
      record.leases.clear();
      if (handle) await handle.release();
      record.state = "stopped";
    }));
    this.records.clear();
  }

  private createRecord(request: AcquireExecutionEnvironmentRequest): EnvironmentRecord {
    const record: EnvironmentRecord = {
      environmentId: randomUUID(),
      ownerId: request.ownerId,
      configHash: request.configHash,
      state: "preparing",
      leases: new Map(),
    };
    record.preparing = request.create({
      ...request.daemonIdentity,
      environmentId: record.environmentId,
      workspaceOwnerId: record.ownerId,
      configHash: record.configHash,
    });
    return record;
  }

  private createLease(
    record: EnvironmentRecord,
    handle: ExecutionEnvironmentHandle,
    leaseId: string,
    consumer: ExecutionEnvironmentConsumer,
  ): ExecutionEnvironmentLease {
    let released = false;
    return {
      ...handle,
      environmentId: record.environmentId,
      ownerId: record.ownerId,
      leaseId,
      consumer: { ...consumer },
      release: async () => {
        if (released) return;
        released = true;
        await this.releaseLease(record, leaseId);
      },
    };
  }

  private async releaseLease(record: EnvironmentRecord, leaseId: string): Promise<void> {
    if (!record.leases.delete(leaseId) || record.leases.size > 0 || record.stopping) return;
    record.state = "stopped";
    record.stopping = (async () => {
      await record.handle?.release();
      if (this.records.get(record.ownerId) === record) this.records.delete(record.ownerId);
    })();
    await record.stopping;
  }
}
