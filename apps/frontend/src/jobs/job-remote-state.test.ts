import { describe, expect, test } from "bun:test";
import type { JobSnapshot } from "@openharness/client";
import {
  beginJobList,
  mergeJobSnapshot,
  rejectJobList,
  resolveJobList,
  validateJobSnapshots,
} from "./job-remote-state";

const job: JobSnapshot = {
  id: "job-1",
  kind: "agent",
  label: "review",
  ownerSession: "s1",
  status: "running",
  capabilities: { read: true, wait: true, send: true, cancel: true },
  cwd: "/repo",
  startedAt: 1,
  updatedAt: 1,
};

describe("JobRemoteState", () => {
  test("loading preserves cached jobs", () => {
    expect(beginJobList({ status: "ready", jobs: [job], refreshedAt: 10 }))
      .toEqual({ status: "loading", jobs: [job] });
  });

  test("loading starts with no cached jobs from idle", () => {
    expect(beginJobList({ status: "idle", jobs: [] }))
      .toEqual({ status: "loading", jobs: [] });
  });

  test("failure preserves cached jobs and does not become empty-ready", () => {
    expect(rejectJobList({ status: "ready", jobs: [job], refreshedAt: 10 }, "offline"))
      .toEqual({ status: "error", jobs: [job], error: "offline", refreshedAt: 10 });
  });

  test("failure from loading keeps cached jobs without a refresh timestamp", () => {
    expect(rejectJobList({ status: "loading", jobs: [job] }, "offline"))
      .toEqual({ status: "error", jobs: [job], error: "offline" });
  });

  test("success distinguishes an authoritative empty result", () => {
    expect(resolveJobList([], 20)).toEqual({ status: "ready", jobs: [], refreshedAt: 20 });
  });

  test("success copies the returned jobs array", () => {
    const jobs = [job];
    const state = resolveJobList(jobs, 20);

    expect(state).toEqual({ status: "ready", jobs: [job], refreshedAt: 20 });
    expect(state.jobs).not.toBe(jobs);
  });

  test("control responses update one snapshot without dropping siblings", () => {
    const sibling = { ...job, id: "job-2" };
    const stopped = { ...job, status: "killed" as const, updatedAt: 30 };
    expect(mergeJobSnapshot({ status: "ready", jobs: [job, sibling], refreshedAt: 10 }, stopped, 30))
      .toMatchObject({ jobs: [stopped, sibling] });
  });

  test("control responses prepend a new snapshot", () => {
    const added = { ...job, id: "job-2" };
    expect(mergeJobSnapshot({ status: "ready", jobs: [job], refreshedAt: 10 }, added, 30))
      .toEqual({ status: "ready", jobs: [added, job], refreshedAt: 30 });
  });

  test("invalid producer records are skipped without inventing shared IDs", () => {
    expect(validateJobSnapshots([
      job,
      { ...job, id: "" },
      { ...job, id: "foreign", ownerSession: "s2" },
    ], "s1")).toEqual({
      jobs: [job],
      error: "Ignored 2 invalid Job snapshots.",
    });
  });

  test("a non-array response is rejected", () => {
    expect(validateJobSnapshots({ jobs: [job] }, "s1")).toEqual({
      jobs: [],
      error: "Jobs response must be an array.",
    });
  });

  test("records with invalid fields are skipped", () => {
    const invalidRecords = [
      { ...job, kind: "unknown" },
      { ...job, status: "unknown" },
      { ...job, label: 123 },
      { ...job, cwd: 123 },
      { ...job, startedAt: Number.NaN },
      { ...job, updatedAt: Number.POSITIVE_INFINITY },
      { ...job, finishedAt: Number.NaN },
      { ...job, capabilities: { ...job.capabilities, read: "yes" } },
    ];

    expect(validateJobSnapshots(invalidRecords, "s1")).toEqual({
      jobs: [],
      error: "Ignored 8 invalid Job snapshots.",
    });
  });
});
