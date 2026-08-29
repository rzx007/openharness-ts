import { describe, expect, it, vi } from "vitest";

import { ApplicationRetentionService } from "../application-retention-service.js";

describe("ApplicationRetentionService attachment lifecycle", () => {
  it("uses one integrity service for scan, safe repair, and GC", async () => {
    const integrity = {
      scan: vi.fn(async () => ({ summary: {}, issues: [] })),
      repairSafe: vi.fn(async () => ({ expiredLeases: 1, deletedOrphanBlobs: 2, releasedBytes: 3 })),
      gc: vi.fn(async () => ({ deletedAssets: 4, deletedBlobs: 5, releasedBytes: 6 })),
    };
    const service = new ApplicationRetentionService(
      { applyRetention: vi.fn(), listRetentionAudits: vi.fn(() => []) } as any,
      integrity as any,
    );

    await expect(service.scanAttachments()).resolves.toEqual({ summary: {}, issues: [] });
    await expect(service.repairAttachments()).resolves.toMatchObject({ expiredLeases: 1 });
    await expect(service.gcAttachments()).resolves.toMatchObject({ deletedAssets: 4 });
    expect(integrity.scan).toHaveBeenCalledWith({ gracePeriodMs: 7 * 24 * 60 * 60 * 1_000 });
    expect(integrity.repairSafe).toHaveBeenCalledWith({ gracePeriodMs: 7 * 24 * 60 * 60 * 1_000 });
    expect(integrity.gc).toHaveBeenCalledWith({ gracePeriodMs: 7 * 24 * 60 * 60 * 1_000 });
  });
});
