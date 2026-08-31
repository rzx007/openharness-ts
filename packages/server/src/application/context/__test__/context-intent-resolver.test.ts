import { describe, expect, it } from "vitest";

import { ContextIntentResolver } from "../context-intent-resolver.js";

describe("ContextIntentResolver", () => {
  const resolver = new ContextIntentResolver();

  it("splits one request into independently governed proposals", async () => {
    const proposals = await resolver.resolve(
      "记住：回答详细一点；代码注释用中文；当前项目提交前必须运行测试",
      { userScopeKey: "local-user", projectId: "project-1", machineId: "machine-1" },
    );

    expect(proposals).toMatchObject([
      { semanticKey: "response.verbosity", scope: "user", kind: "user_preference" },
      { semanticKey: "code.comment_language", scope: "user", kind: "user_preference" },
      { semanticKey: "git.pre_commit_test", scope: "project", scopeKey: "project-1", kind: "project_rule" },
    ]);
  });

  it("marks replacement language and secret material", async () => {
    const [replacement] = await resolver.resolve(
      "把这个项目的包管理器改成 pnpm",
      { userScopeKey: "local-user", projectId: "project-1" },
    );
    const [secret] = await resolver.resolve(
      "记住 API key 是 sk-test-secret",
      { userScopeKey: "local-user" },
    );

    expect(replacement).toMatchObject({ semanticKey: "node.package_manager", replace: true });
    expect(secret).toMatchObject({ sensitivity: "secret" });
  });

  it("uses the injected classifier only when deterministic rules cannot resolve the request", async () => {
    let calls = 0;
    const classified = new ContextIntentResolver({
      classifier: {
        classify: async () => {
          calls += 1;
          return [{
            title: "称呼",
            content: "称呼用户为老师。",
            kind: "user_preference",
            scope: "user",
            scopeKey: "local-user",
            semanticKey: "response.user_address",
            confidence: 0.93,
            sensitivity: "none",
            evidence: "以后叫我老师",
            replace: false,
          }];
        },
      },
    });

    expect(await classified.resolve("以后叫我老师", { userScopeKey: "local-user" }))
      .toHaveLength(1);
    expect(calls).toBe(1);
  });
});
