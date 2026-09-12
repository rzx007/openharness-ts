import { describe, expect, it } from "vitest";
import { parseCreateSessionGoalInput, parseGoalActionInput, parseGoalAssessment } from "./session-goals.js";

describe("session goal protocol", () => {
  it("normalizes valid goal input", () => {
    expect(
      parseCreateSessionGoalInput({
        requestId: "r1",
        objective: "  完成目标  ",
      }),
    ).toEqual({ requestId: "r1", objective: "完成目标" });
  });

  it("rejects empty goals and invalid resume budgets", () => {
    expect(() => parseCreateSessionGoalInput({ requestId: "r1", objective: " " })).toThrow();
    expect(() =>
      parseGoalActionInput({
        requestId: "r1",
        expectedRevision: 0,
        action: "resume",
        additionalAutoTurns: 0,
      }),
    ).toThrow();
  });

  it("validates structured goal content instead of casting unknown input", () => {
    for (const value of [null, {}, [{ type: "unknown" }], [{ type: "text", text: 7 }]]) {
      expect(() =>
        parseCreateSessionGoalInput({
          requestId: "r1",
          objective: "完成目标",
          items: value,
        }),
      ).toThrow();
    }
    expect(() =>
      parseCreateSessionGoalInput({
        requestId: "r1",
        objective: "完成目标",
        attachments: [{ assetId: "" }],
      }),
    ).toThrow();
    expect(
      parseCreateSessionGoalInput({
        requestId: "r1",
        objective: "完成目标",
        items: [
          {
            type: "context",
            kind: "conversation",
            id: "s1",
            displayName: "说明",
          },
        ],
      }).items?.[0].type,
    ).toBe("context");
  });

  it("binds evidence to the host run and rejects malformed assessments", () => {
    const binding = { goalId: "g1", revision: 2, runId: "r1" };
    const assessment = parseGoalAssessment(
      {
        goalId: "forged",
        runId: "forged",
        decision: "complete",
        progress: "verified",
        progressAssessment: { kind: "progress", summary: "已完成" },
        evidence: ["test passed"],
        evidenceRefs: [{ messagePartId: "part1", criterion: "test passes", runId: "forged" }],
        requirements: [
          {
            requirement: "tests pass",
            source: "objective",
            status: "satisfied",
            evidenceRefs: [{ messagePartId: "part1", criterion: "test passes" }],
          },
        ],
        remainingWork: [],
      },
      binding,
    );
    expect(assessment).toMatchObject(binding);
    expect(assessment.evidenceRefs[0]).toMatchObject(binding);
    const waiting = parseGoalAssessment(
      {
        decision: "waiting_user",
        progress: "等待确认",
        progressAssessment: { kind: "waiting", summary: "等待用户" },
        evidence: [],
        question: "选哪个数据源？",
      },
      binding,
    );
    expect(parseGoalAssessment(waiting, binding)).toEqual(waiting);
    for (const decision of ["done", null, 1]) expect(() => parseGoalAssessment({ decision, progress: "work", evidence: [] }, binding)).toThrow();
  });

  it("requires a complete decision to audit every requirement", () => {
    const binding = { goalId: "g1", revision: 2, runId: "r1" };
    const complete = {
      decision: "complete",
      progress: "完成实现和验证",
      progressAssessment: { kind: "progress", summary: "完成实现和验证" },
      evidence: ["实现检查通过"],
      evidenceRefs: [{ messagePartId: "part1", criterion: "实现已完成" }],
      requirements: [
        {
          requirement: "实现功能",
          source: "目标正文",
          status: "satisfied",
          evidenceRefs: [{ messagePartId: "part1", criterion: "实现已完成" }],
        },
      ],
      remainingWork: [],
    };
    expect(parseGoalAssessment(complete, binding)).toMatchObject({
      requirements: [
        {
          status: "satisfied",
          evidenceRefs: [expect.objectContaining(binding)],
        },
      ],
      remainingWork: [],
    });
    expect(() => parseGoalAssessment({ ...complete, requirements: [] }, binding)).toThrow();
    expect(parseGoalAssessment({ ...complete, remainingWork: ["补文档"] }, binding).remainingWork).toEqual(["补文档"]);
  });

  it("requires a stable blocker key for no-progress assessments", () => {
    const binding = { goalId: "g1", revision: 1, runId: "r1" };
    expect(() =>
      parseGoalAssessment(
        {
          decision: "blocked",
          progress: "缺少配置",
          progressAssessment: { kind: "no_progress", summary: "缺少配置" },
          evidence: [],
        },
        binding,
      ),
    ).toThrow();
    expect(
      parseGoalAssessment(
        {
          decision: "blocked",
          progress: "缺少配置",
          progressAssessment: {
            kind: "no_progress",
            summary: "缺少配置",
            blockerKey: "missing-config",
          },
          evidence: [],
        },
        binding,
      ).progressAssessment,
    ).toEqual({
      kind: "no_progress",
      summary: "缺少配置",
      blockerKey: "missing-config",
    });
  });

  it("binds an external wait to the current run", () => {
    const binding = { goalId: "g1", revision: 1, runId: "r1" };
    const value = parseGoalAssessment(
      {
        decision: "continue",
        progress: "等待构建",
        progressAssessment: { kind: "waiting", summary: "构建仍在运行" },
        evidence: [],
        wait: {
          kind: "external",
          handleId: "run-build",
          runId: "forged",
          deadlineAt: 2_000_000_000_000,
        },
      },
      binding,
    );
    expect(value.wait).toEqual({
      kind: "external",
      handleId: "run-build",
      runId: "r1",
      deadlineAt: 2_000_000_000_000,
    });
  });
});
