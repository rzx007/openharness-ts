import {
  DEFAULT_RETENTION_POLICY,
  type RetentionPolicy,
  type SessionStore,
} from "@openharness/services";

/** 手动或定时运行的数据清理入口；每次结果都会写入 retention_audit。 */
export class ApplicationRetentionService {
  constructor(private readonly store: SessionStore) {}

  get policy(): RetentionPolicy {
    return { ...DEFAULT_RETENTION_POLICY };
  }

  run(policy: RetentionPolicy = DEFAULT_RETENTION_POLICY, timestamp = Date.now()) {
    return this.store.applyRetention(policy, timestamp);
  }

  audits(): Array<Record<string, unknown>> {
    return this.store.listRetentionAudits();
  }
}
