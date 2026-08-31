# Context Persistence 统一持久化控制层实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 用 daemon 拥有的 `ContextPersistenceService` 统一管理长期上下文，在集中式托管目录中继续使用 Markdown，使 Agent 只能通过语义工具记住、查询、修改和忘记上下文。

**架构：** Context 领域类型、主题文档/block schema 2 和纯策略位于新的 `@openharness/context` 包；`MarkdownContextStore` 位于 `@openharness/services`，只操作 `<configDir>/context/{user,machines,projects}` 下的有限主题文件。一个主题文件包含多个可独立管理的 entry blocks；daemon application service 组合 Resolver、Store、自动提取、受控整合和 Prompt 查询，并通过 host capability 向 Agent 安装语义工具。所有客户端使用 `/context/*` 资源 API；最后一次性删除旧 memory/personalization/USER 链路，不做双写和兼容读取。

**技术栈：** TypeScript、Vitest、Node.js filesystem、Markdown frontmatter、Hono、React/Electron、OpenHarness Agent runtime 和 SessionStore。

---

## 文件结构

### 新 Context 领域包

- 创建 `packages/context/package.json`：声明新 workspace package 和测试/typecheck scripts。
- 创建 `packages/context/src/types.ts`：Context proposal、entry、decision、逐条结果和批量结果联合类型。
- 创建 `packages/context/src/normalize.ts`：内容规范化和稳定语义签名。
- 创建 `packages/context/src/policy.ts`：阈值、作用域/类型一致性、敏感度和自动提交策略。
- 创建 `packages/context/src/conflicts.ts`：幂等、冲突和显式替换决策。
- 创建 `packages/context/src/topics.ts`：把已验证 proposal 路由到有限主题，不接受模型文件名。
- 创建 `packages/context/src/markdown.ts`：schema 2 主题文档、显式 entry block 边界、解析、校验和稳定渲染。
- 创建 `packages/context/src/prompt.ts`：检索评分、覆盖规则和字符预算渲染。
- 创建 `packages/context/src/index.ts`：只导出稳定公共接口。
- 创建相邻 `*.test.ts`：对每个纯领域行为做表驱动测试。

### Markdown store 与 daemon 服务

- 创建 `packages/services/src/context/context-paths.ts`：只在服务内部初始化 `.machine-id`，并把 scope/topic 映射到固定主题文件。
- 创建 `packages/services/src/context/markdown-context-store.ts`：扫描、block 解析、按主题合并、同作用域锁、临时文件复读、原子重写和 pending 移动。
- 创建 `packages/services/src/context/__test__/markdown-context-store.test.ts`：真实临时目录下的主题路由、block schema、故障、并发、候选和人工内容保留测试。
- 修改 `packages/services/src/index.ts`：导出 store，不导出 Context 根目录解析细节给 Agent runtime。
- 创建 `packages/server/src/application/context/context-intent-resolver.ts`：确定性规则、分类模型边界和结果校验。
- 创建 `packages/server/src/application/context/context-persistence-service.ts`：统一用例编排。
- 创建 `packages/server/src/application/context/context-extraction-service.ts`：Run 后自动提取和候选策略。
- 创建 `packages/server/src/application/context/context-query-service.ts`：每轮 Prompt 查询。
- 创建相邻 `__test__`：服务级行为测试。

### Agent 工具和 Runtime

- 修改 `packages/core/src/types/tools.ts`：增加 `AgentContextMemoryHost` 和 ToolContext capability。
- 修改 `packages/agent-runtime/src/agent-options.ts`、`agent-composition.ts`、`default-runtime.ts` 和 QueryEngine setter：贯通 host。
- 创建 `packages/tools/src/context/context-tools.ts`：Remember、ResolveContextDecision、RecallContext、UpdateContext、ForgetContext。
- 修改 `packages/tools/src/registry.ts`：仅 host 可用时注册工具。
- 修改 `packages/server/src/daemon/daemon-agent.ts` 和 `application/daemon-application.ts`：给每个 session 注入 daemon host。

### Prompt、API 和客户端

- 修改 `packages/prompts/src/index.ts`：接受渲染后的 Context bundle，不读取 USER/local rules。
- 修改 `packages/core/src/engine/query-engine.ts`：每轮用户输入前读取 Context bundle。
- 创建 `packages/server/src/http/routes/context.ts`：entries/candidates/status/preview API。
- 修改 `packages/server/src/http/server.ts`：挂载 Context routes，删除 memory route。
- 修改 `packages/client/src/types/index.ts` 和 `transport/http-client.ts`：新 Context 类型与方法。
- 修改 `packages/client/src/commands/session-commands.ts`：实现 `/context` 和新的 `/remember <content>`。
- 创建 `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/utility-panel/context-panel.tsx` 及测试：Context 管理面板。
- 修改 utility panel 入口：加入 Context tab，不修改消息卡片。

### 保护与硬切删除

- 创建 `packages/tools/src/file/managed-resource-policy.ts`：托管资源写入检查。
- 修改 `packages/tools/src/file/write.ts`、`edit.ts` 和 runtime ToolContext 注入：写前拒绝托管路径。
- 删除 `packages/memory/`、`packages/personalization/`、`packages/agent-runtime/src/memory-runtime.ts`、`packages/services/src/memory-extract.ts`。
- 删除 server 旧 memory service/routes 和 prompts 的 USER pending API。
- 删除 `service.ts` 中旧 profile/context-preview 契约；新的 `/agent-identity` 只管理 SOUL，Context preview 由任务 8 的资源 API 提供。`/dream` 保留命令名，但改走任务 7 的受控整合服务。
- 修改配置、文档、依赖和测试，删除所有旧运行时引用。

## 执行原则与阶段门

- 每个任务独立走红灯测试、最小实现、绿灯验证、提交；不得把任务 11 的删除混进前面提交。
- 任务 1～3 完成后，必须能只通过 service 测试证明写入策略正确；此时不接 UI，也不启用自动提取。
- 任务 4～6 完成后，必须能证明 Agent 只走语义工具、下一轮立即召回、自动内容受同一策略约束。
- 任务 7～10 完成后，dream、API、Slash 和桌面端都只使用逻辑 ID/scope，不接触存储路径。
- 只有上述门槛全部通过，任务 11 才删除旧包、旧配置、旧路由和旧 Prompt 来源。
- 本次不迁移、不双写、不回读旧数据；已有 `USER.md`、`rules.md` 和 Project Memory 保留在磁盘但变成未使用文件。
- 旧 `local_rules/rules.md` 的可读用途由 `/context/preview` 和桌面预览替代。新 `projects/<id>/rules.md` 只是 Context 服务托管的项目规则主题容器，不由 Prompt 层直接整文件读取。
- 回滚只允许回滚发布版本并恢复升级前的 Context 目录备份；不在新版本里保留旧实现作为运行时 fallback。

---

### 任务 1：Context 领域契约和纯策略

**文件：**
- 创建：`packages/context/package.json`
- 创建：`packages/context/src/types.ts`
- 创建：`packages/context/src/normalize.ts`
- 创建：`packages/context/src/policy.ts`
- 创建：`packages/context/src/conflicts.ts`
- 创建：`packages/context/src/topics.ts`
- 创建：`packages/context/src/markdown.ts`
- 创建：`packages/context/src/index.ts`
- 测试：`packages/context/src/normalize.test.ts`
- 测试：`packages/context/src/policy.test.ts`
- 测试：`packages/context/src/conflicts.test.ts`
- 测试：`packages/context/src/topics.test.ts`
- 测试：`packages/context/src/markdown.test.ts`

- [ ] **步骤 1：编写失败的领域测试**

用字面 fixture 覆盖四个关键行为：

```ts
it.each([
  ["user_preference", "user", true],
  ["project_rule", "project", true],
  ["project_knowledge", "project", true],
  ["environment_fact", "machine", true],
  ["user_preference", "project", false],
])("validates %s in %s scope", (kind, scope, valid) => {
  expect(validateKindScope(kind, scope).valid).toBe(valid);
});

it("rejects secrets regardless of confidence", () => {
  expect(decideExplicitCommit({ confidence: 1, sensitivity: "secret", scopeResolved: true }))
    .toEqual({ action: "reject", reason: "secret" });
});

it("auto-commits only high-confidence environment facts", () => {
  expect(decideAutomaticCandidate({ kind: "environment_fact", confidence: 0.96, sensitivity: "none", scopeResolved: true, conflicts: false }))
    .toBe("commit");
  expect(decideAutomaticCandidate({ kind: "project_knowledge", confidence: 0.99, sensitivity: "none", scopeResolved: true, conflicts: false }))
    .toBe("candidate");
});

it("treats same semantic slot with different content as a conflict", () => {
  expect(detectContextConflict(existingEntry, { ...proposal, content: "Use pnpm" }))
    .toEqual({ status: "conflict", existingId: existingEntry.id });
});

it("round-trips multiple schema-v2 blocks in one topic document", () => {
  const document = topicDocument("ui-design", [colorPreference, gradientPreference]);
  const markdown = renderContextDocument(document);
  expect(parseContextDocument(markdown)).toEqual(document);
});

it("keeps independently mutable preferences as separate proposals", () => {
  expect(validateProposalBatch([responsePreference, commentLanguagePreference]))
    .toMatchObject({ valid: true, count: 2 });
});

it.each([
  [userPreference("ui.design.shadows"), "ui-design"],
  [userPreference("response.verbosity"), "preferences"],
  [userPreference("node.package_manager"), "development-workflow"],
  [projectRule, "rules"],
  [projectKnowledge, "knowledge"],
  [machineFact, "environment"],
])("routes %o to the finite topic %s", (proposal, topic) => {
  expect(routeContextTopic(proposal)).toBe(topic);
});
```

- [ ] **步骤 2：运行测试确认红灯**

```bash
pnpm --filter @openharness/context test
```

预期：包或导出函数尚不存在，测试失败。

- [ ] **步骤 3：实现最小领域类型和策略**

在 `types.ts` 定义 topic、proposal、entry、topic document、item result 和 batch result；在 `policy.ts` 固定显式阈值 `0.85`、自动环境事实阈值 `0.95`；在 `normalize.ts` 只做小写、空白折叠和标点规范化；在 `conflicts.ts` 返回 `noop | conflict | replace | create`；在 `topics.ts` 根据 scope/kind/semantic key 返回有限 topic，无法确定时返回 pending；在 `markdown.ts` 从现有 MemoryManager 提取 frontmatter 基础能力，并新增显式 `context-entry` 开始/结束标记解析，严格只接受 schema 2。解析和渲染必须保留文档标题及未托管的人类说明；纯领域包不访问文件系统。

- [ ] **步骤 4：验证绿灯和类型**

```bash
pnpm --filter @openharness/context test
pnpm --filter @openharness/context check-types
```

- [ ] **步骤 5：提交**

```bash
git add packages/context
git commit -m "feat(context): define persistence domain policies"
```

### 任务 2：托管 MarkdownContextStore

**文件：**
- 创建：`packages/services/src/context/context-paths.ts`
- 创建：`packages/services/src/context/context-lock.ts`
- 创建：`packages/services/src/context/markdown-context-store.ts`
- 创建：`packages/services/src/context/index.ts`
- 创建：`packages/services/src/context/__test__/context-paths.test.ts`
- 创建：`packages/services/src/context/__test__/markdown-context-store.test.ts`
- 修改：`packages/services/src/index.ts`
- 修改：`packages/services/package.json`

- [ ] **步骤 1：编写路径和 schema 失败测试**

用真实临时 config root 验证并发首次初始化只产生一个稳定 `.machine-id`；user、machine、project scope 只映射到托管根内部；非法 scope key、`..`、绝对路径和分隔符不能逃逸。主题路由只能返回固定文件：user 的 `preferences/ui-design/development-workflow/pending`，machine 的 `environment/pending`，project 的 `rules/knowledge/environment/pending`；模型提供的任意文件名必须被忽略或拒绝。

```ts
expect(paths.directoryFor({ scope: "project", scopeKey: "project-1" }))
  .toBe(join(root, "projects", "project-1"));
expect(paths.documentFor({ scope: "user", scopeKey: "local-user", topic: "ui-design" }))
  .toBe(join(root, "user", "ui-design.md"));
expect(() => paths.directoryFor({ scope: "project", scopeKey: "../outside" }))
  .toThrow(/invalid scope key/i);
```

- [ ] **步骤 2：编写原子文件行为失败测试**

覆盖：一次 upsert 三条 UI 偏好只创建 `user/ui-design.md` 且含三个 blocks；candidate/disabled/superseded 不进入 active list；相同 semantic key 只有一条 active；update 保持 ID 且只替换目标 block；forget 删除 block 而不破坏相邻内容；人工写在 blocks 外的说明保持原样；无效 block 被隔离并报告；临时写入失败不替换正式主题文件；两个并发 replace 被同作用域锁串行化；过期 pending block 被清理。

```ts
await store.upsertMany([colorPreference, gradientPreference, radiusPreference]);
expect(await readdir(join(root, "user"))).toEqual(["ui-design.md"]);
expect(parseContextDocument(await readFile(join(root, "user", "ui-design.md"), "utf8")).entries)
  .toHaveLength(3);
```

- [ ] **步骤 3：运行红灯测试**

```bash
pnpm --filter @openharness/services test -- context-paths.test.ts markdown-context-store.test.ts
```

预期：Context paths、lock 和 store 尚不存在。

- [ ] **步骤 4：实现 Markdown store**

`MarkdownContextStore` 使用 `@openharness/context` 的 document/block parser。mutation 先按 scope/topic 分组，同一主题只重写一次：读取旧文档、按 ID/semantic key 更新 blocks、保留未托管说明、渲染临时文件、复读并比对 entry IDs、`rename` 到正式主题文件。所有 mutation 通过 `ContextScopeLock.run(scope, scopeKey, callback)` 串行化。接受候选时先幂等插入目标主题，再删除 `pending.md` 中同 ID block；启动扫描负责清理中断造成的 active/pending 重复。

- [ ] **步骤 5：运行 store 绿灯和类型检查**

```bash
pnpm --filter @openharness/services test -- context-paths.test.ts markdown-context-store.test.ts
pnpm --filter @openharness/services check-types
```

- [ ] **步骤 6：提交**

```bash
git add packages/services packages/context package.json pnpm-lock.yaml
git commit -m "feat(context): persist managed markdown entries"
```

### 任务 3：Resolver、敏感策略和统一用例服务

**文件：**
- 创建：`packages/server/src/application/context/context-intent-resolver.ts`
- 创建：`packages/server/src/application/context/context-sensitive-data.ts`
- 创建：`packages/server/src/application/context/context-persistence-service.ts`
- 创建：`packages/server/src/application/context/index.ts`
- 创建：`packages/server/src/application/context/__test__/context-intent-resolver.test.ts`
- 创建：`packages/server/src/application/context/__test__/context-persistence-service.test.ts`
- 修改：`packages/server/src/application/index.ts`

- [ ] **步骤 1：写显式请求行为测试**

表驱动测试至少覆盖：全局偏好直接提交、当前项目规则直接提交、projectless 项目规则要求澄清、内部 IP 要求敏感确认、API key 永久拒绝、相同内容 noop、同 key 不同内容冲突、带“改成”的请求原子替换，以及一次请求拆出多个独立 proposal。

```ts
await expect(service.remember(explicit("记住这个项目统一使用 pnpm", projectSession)))
  .resolves.toMatchObject({
    status: "completed",
    results: [{
      status: "committed",
      entry: { kind: "project_rule", scope: "project", scopeKey: "project-1" },
    }],
  });

await expect(service.remember(explicit(
  "记住：回答详细一点；代码注释用中文；当前项目提交前必须运行测试",
  projectSession,
))).resolves.toMatchObject({
  results: [
    { status: "committed", entry: { semanticKey: "response.verbosity", scope: "user" } },
    { status: "committed", entry: { semanticKey: "code.comment_language", scope: "user" } },
    { status: "committed", entry: { semanticKey: "git.pre_commit_test", scope: "project" } },
  ],
});
```

- [ ] **步骤 2：运行测试确认失败**

```bash
pnpm --filter @openharness/server test -- context-intent-resolver.test.ts context-persistence-service.test.ts
```

- [ ] **步骤 3：实现确定性 Resolver 和受控分类边界**

Resolver 先使用明确中文/英文作用域信号和秘密正则；无法达到阈值时调用注入的 `ContextClassifier`，只接受严格 JSON：

```ts
interface ContextProposal {
  title: string;
  kind: ContextKind;
  scope: ContextScope;
  scopeKey?: string;
  semanticKey: string;
  content: string;
  confidence: number;
  sensitivity: ContextSensitivity;
  replace: boolean;
  evidence: string;
}
```

分类器只返回 `ContextProposal[]`。输出经过 schema、kind/scope、秘密和拆分完整性校验后，Service 才逐条调用 `MarkdownContextStore`。同批每条独立返回 committed/noop/clarification/rejected/failed；decision 只存在当前 daemon 会话状态，不写长期 Markdown。

- [ ] **步骤 4：运行绿灯和 server 类型检查**

```bash
pnpm --filter @openharness/server test -- context-intent-resolver.test.ts context-persistence-service.test.ts
pnpm --filter @openharness/server check-types
```

- [ ] **步骤 5：提交**

```bash
git add packages/server/src/application/context packages/server/src/application/index.ts
git commit -m "feat(context): resolve and govern context mutations"
```

### 任务 4：Agent 语义工具和 daemon host 接线

**文件：**
- 修改：`packages/core/src/types/tools.ts`
- 修改：`packages/core/src/engine/query-engine.ts`
- 修改：`packages/agent-runtime/src/agent-options.ts`
- 修改：`packages/agent-runtime/src/agent-composition.ts`
- 修改：`packages/agent-runtime/src/default-runtime.ts`
- 创建：`packages/tools/src/context/context-tools.ts`
- 创建：`packages/tools/src/context/index.ts`
- 创建：`packages/tools/src/context/context-tools.test.ts`
- 修改：`packages/tools/src/registry.ts`
- 修改：`packages/server/src/daemon/daemon-agent.ts`
- 修改：`packages/server/src/application/daemon-application.ts`
- 测试：相邻 agent/runtime/daemon tests

- [ ] **步骤 1：编写 host 与工具失败测试**

断言无 host 时工具不注册；有 host 时五个工具注册；Remember 传递真实 `sessionId/runId/inputId/cwd`；单条和批量的 committed/noop/clarification/rejected/failed 均返回结构化、无路径文本；子 Agent 继承 host 但使用自己的 session 上下文。

- [ ] **步骤 2：运行红灯测试**

```bash
pnpm --filter @openharness/tools test -- context-tools.test.ts registry.test.ts
pnpm --filter @openharness/agent-runtime test -- default-runtime.test.ts child-agent.test.ts
pnpm --filter @openharness/server test -- durable-agent-application.test.ts
```

- [ ] **步骤 3：实现 capability 和工具**

给 ToolContext 增加可选 `contextMemory`，定义 host 的 remember/resolve/recall/update/forget 方法。`createDefaultToolRegistry({ contextMemory: true })` 才注册工具；QueryEngine 将 host 放入每次 ToolContext；daemon adapter 从 SessionStore 补齐 projectId 和 provenance 后调用 service。

- [ ] **步骤 4：增加稳定 Agent 指令**

在 runtime 基础指令中加入：明确记住/修改/忘记时使用 Context 工具；不得定位或编辑持久化文件；工具返回 needs clarification 时只问返回的问题。测试断言工具行为，不只 grep Prompt 文本。

- [ ] **步骤 5：运行相关测试和类型检查**

```bash
pnpm --filter @openharness/core test
pnpm --filter @openharness/tools test
pnpm --filter @openharness/agent-runtime test
pnpm --filter @openharness/server test -- durable-agent-application.test.ts
pnpm --filter @openharness/server check-types
```

- [ ] **步骤 6：提交**

```bash
git add packages/core packages/tools packages/agent-runtime packages/server
git commit -m "feat(context): expose governed memory tools to agents"
```

### 任务 5：每轮 Context 查询和 Prompt 新鲜度

**文件：**
- 创建：`packages/context/src/prompt.ts`
- 创建：`packages/context/src/prompt.test.ts`
- 创建：`packages/server/src/application/context/context-query-service.ts`
- 创建：`packages/server/src/application/context/__test__/context-query-service.test.ts`
- 修改：`packages/core/src/types/runtime.ts`
- 修改：`packages/core/src/engine/query-engine.ts`
- 修改：`packages/prompts/src/index.ts`
- 修改：`packages/server/src/application/default-services/context-service.ts`

- [ ] **步骤 1：编写检索和覆盖失败测试**

验证 project rule 覆盖相同 key 的 user preference；machine/project facts 不跨项目；knowledge 按当前输入匹配；总长度不超过 12,000 字符；新写入内容在同一个热 Agent 的下一轮可见。

```ts
await run("记住这个项目使用 pnpm");
const secondTurn = await captureModelRequest("安装依赖");
expect(secondTurn.system).toContain("当前项目使用 pnpm");
expect(agentFactory).toHaveBeenCalledTimes(1);
```

- [ ] **步骤 2：运行红灯测试**

```bash
pnpm --filter @openharness/context test -- prompt.test.ts
pnpm --filter @openharness/server test -- context-query-service.test.ts session-run-executor.test.ts
pnpm --filter @openharness/prompts test
```

- [ ] **步骤 3：实现每轮 retriever**

新增 `ContextRetriever(userInput, runtimeScope)`，由 QueryEngine 在每次物理模型请求组装前调用。Store 先把主题文档解析为逻辑 entries，Retriever 只按 entry 相关性选择，不整文件注入。Prompt 包只渲染传入的 bundle；不缓存 mutable entries，不因 context mutation 关闭 Agent。模型请求成功组装后在内存聚合 markUsed，由维护阶段批量刷新涉及的主题文件。

- [ ] **步骤 4：验证 Prompt 分层和 compact 不受影响**

```bash
pnpm --filter @openharness/core test -- query-engine compact-service-advanced
pnpm --filter @openharness/prompts test
pnpm --filter @openharness/server test -- context-query-service.test.ts session-run-executor.test.ts
```

- [ ] **步骤 5：提交**

```bash
git add packages/context packages/core packages/prompts packages/server
git commit -m "feat(context): inject fresh scoped context per turn"
```

### 任务 6：自动环境事实和候选管线

**文件：**
- 创建：`packages/server/src/application/context/context-extraction-service.ts`
- 创建：`packages/server/src/application/context/environment-fact-extractor.ts`
- 创建：`packages/server/src/application/context/__test__/context-extraction-service.test.ts`
- 修改：`packages/server/src/application/session/session-post-run-maintenance.ts`
- 修改：`packages/server/src/application/session/__test__/session-post-run-maintenance.test.ts`
- 修改：`packages/server/src/application/daemon-application.ts`

- [ ] **步骤 1：编写自动策略失败测试**

覆盖：0.96 非敏感 project endpoint 自动提交到项目 `environment.md`；0.90 endpoint 作为 block 进入项目 `pending.md`；高置信度 project knowledge 仍进入 pending；内部 IP 标为 sensitive 并进入 pending；多个候选聚合在一个 pending 文档；secret 丢弃；failed/interrupted Run 不提取；自动提取失败不改变 completed Run。

- [ ] **步骤 2：运行红灯测试**

```bash
pnpm --filter @openharness/server test -- context-extraction-service.test.ts session-post-run-maintenance.test.ts
```

- [ ] **步骤 3：实现提取和维护接线**

从 durable transcript 生成 proposal；确定性 extractor 只识别路径、host、IP、endpoint、environment name，并为每个命中提供证据位置。所有 proposal 进入同一个 policy；自动提交项由主题路由写入 environment 文档，其余按作用域合并写入 pending 文档。SessionPostRunMaintenance 在 Session Memory 写入之后调用 extraction service。

- [ ] **步骤 4：运行绿灯测试**

```bash
pnpm --filter @openharness/server test -- context-extraction-service.test.ts session-post-run-maintenance.test.ts durable-agent-application.test.ts
```

- [ ] **步骤 5：提交**

```bash
git add packages/server/src/application/context packages/server/src/application/session packages/server/src/application/daemon-application.ts
git commit -m "feat(context): extract governed context after completed runs"
```

### 任务 7：服务受控的 `/dream` 整合

**文件：**
- 创建：`packages/server/src/application/context/context-consolidation-service.ts`
- 创建：`packages/server/src/application/context/__test__/context-consolidation-service.test.ts`
- 创建：`packages/services/src/context/context-backup.ts`
- 创建：`packages/services/src/context/__test__/context-backup.test.ts`
- 修改：`packages/server/src/application/default-services/dream-service.ts`
- 修改：`packages/server/src/application/settings-api.ts`
- 修改：`packages/server/src/application/daemon-application.ts`

- [ ] **步骤 1：编写结构化整合失败测试**

覆盖：preview 只返回 merge/update/disable 计划且不写文件；模型输出 path/directory 或未知 entry ID 时拒绝；执行前备份涉及的主题文档；同主题 merge 只重写一个文件；跨主题 merge 由服务确定目标 topic 并更新相关 blocks；中途失败报告逐项结果且保留可恢复备份。

```ts
const result = await service.consolidate({ scope: "project", scopeKey: "project-1", preview: true });
expect(result.operations).toEqual([
  { type: "merge", sourceIds: ["ctx-a", "ctx-b"], content: "统一后的项目规则" },
]);
expect(store.update).not.toHaveBeenCalled();
```

- [ ] **步骤 2：运行红灯测试**

```bash
pnpm --filter @openharness/services test -- context-backup.test.ts
pnpm --filter @openharness/server test -- context-consolidation-service.test.ts
```

- [ ] **步骤 3：实现结构化操作边界**

模型只接收逻辑 entry ID、topic、metadata 和正文，不接收 Context 根目录；只允许 `merge | update | disable`。Service 校验所有 ID 属于请求 scope、输出不含路径字段、秘密扫描通过且操作数在上限内，并自行决定合并后的有限目标 topic，再调用 `MarkdownContextStore` 更新 blocks。继续支持 `/dream --preview`，但删除旧的“子进程直接编辑 memory 目录”执行方式。

- [ ] **步骤 4：运行绿灯测试**

```bash
pnpm --filter @openharness/services test -- context-backup.test.ts markdown-context-store.test.ts
pnpm --filter @openharness/server test -- context-consolidation-service.test.ts default-application-services.test.ts
```

- [ ] **步骤 5：提交**

```bash
git add packages/services/src/context packages/server/src/application/context packages/server/src/application/default-services/dream-service.ts packages/server/src/application/settings-api.ts packages/server/src/application/daemon-application.ts
git commit -m "feat(context): consolidate markdown through governed operations"
```

### 任务 8：Context REST API、typed client 和 Slash 命令

**文件：**
- 创建：`packages/server/src/http/routes/context.ts`
- 创建：`packages/server/src/http/routes/__test__/context.test.ts`
- 修改：`packages/server/src/http/server.ts`
- 修改：`packages/server/src/http/routes/service.ts`
- 修改：`packages/server/src/application/settings-api.ts`
- 修改：`packages/client/src/types/index.ts`
- 修改：`packages/client/src/transport/http-client.ts`
- 修改：`packages/client/src/transport/__test__/http-client.test.ts`
- 修改：`packages/client/src/commands/session-commands.ts`
- 修改：`packages/client/src/commands/__test__/session-commands.test.ts`

- [ ] **步骤 1：编写 API 契约失败测试**

逐个测试规格中的 entries/candidates/status/preview 路由；作用域参数非法返回 400；不存在 ID 返回 404；secret 返回 422；active cwd mutation 冲突返回 409；响应不含 `directory` 或 `path`。

- [ ] **步骤 2：编写 command 失败测试**

验证 `/context list/show/add/update/remove/candidates/accept/reject/status/preview` 和 `/remember <content>` 调用 typed client；成功只输出逻辑作用域和 ID，不输出路径。

- [ ] **步骤 3：运行红灯测试**

```bash
pnpm --filter @openharness/server test -- context.test.ts http.test.ts
pnpm --filter @openharness/client test -- http-client.test.ts session-commands.test.ts
```

- [ ] **步骤 4：实现 routes、client 和 commands**

所有 mutation 使用 daemon operation gate；写入后无需 close runtime，因为下一轮动态查询。删除 `service.ts` 当前只提供 preview/status 的旧 `/context` 入口，避免新旧 Context 契约并存；preview/status 统一进入新的资源 routes。`/remember` 无参数时只输出 `Usage: /remember <content>`。

- [ ] **步骤 5：运行 package 测试和类型检查**

```bash
pnpm --filter @openharness/server test
pnpm --filter @openharness/client test
pnpm --filter @openharness/server check-types
pnpm --filter @openharness/client check-types
```

- [ ] **步骤 6：提交**

```bash
git add packages/server packages/client
git commit -m "feat(context): add resource API and client commands"
```

### 任务 9：托管资源保护和 Agent Identity 边界

**文件：**
- 创建：`packages/tools/src/file/managed-resource-policy.ts`
- 创建：`packages/tools/src/file/__test__/managed-resource-policy.test.ts`
- 修改：`packages/core/src/types/tools.ts`
- 修改：`packages/tools/src/file/write.ts`
- 修改：`packages/tools/src/file/edit.ts`
- 修改：`packages/agent-runtime/src/agent-options.ts`
- 修改：`packages/agent-runtime/src/agent-composition.ts`
- 修改：`packages/server/src/daemon/daemon-agent.ts`
- 修改：`packages/server/src/application/default-services/profile-service.ts`
- 修改：`packages/server/src/http/routes/service.ts`

- [ ] **步骤 1：编写保护失败测试**

真实执行 Write/Edit，断言 Context Markdown 根目录、credentials 和 `SOUL.md` 返回 `failureKind: "policy"`；普通工作区文件仍可写；路径大小写、`..` 和 Windows 分隔符无法绕过。SOUL 的用户诊断读取只通过身份服务提供，不把其路径注入 Agent 上下文。

- [ ] **步骤 2：运行红灯测试**

```bash
pnpm --filter @openharness/tools test -- managed-resource-policy.test.ts operations.test.ts
pnpm --filter @openharness/server test -- default-application-services.test.ts
```

- [ ] **步骤 3：实现 host-owned policy**

ToolContext 增加 `managedResources.check(path, operation)`；Write/Edit 在 sandbox check 前调用。daemon 用规范化绝对路径注册整个 Context Markdown 根目录、credentials 和 SOUL。返回消息只说“managed context resource”，不回显隐藏目录路径。

- [ ] **步骤 4：收窄 ProfileService**

把 `/profile` 改成 `/agent-identity`，init/status 只管理 SOUL；删除 USER pending 能力。身份服务可以向用户报告 SOUL 路径，但该路径不进入 Agent Prompt 或工具返回。

- [ ] **步骤 5：验证**

```bash
pnpm --filter @openharness/tools test
pnpm --filter @openharness/agent-runtime test
pnpm --filter @openharness/server test -- default-application-services.test.ts http.test.ts
```

- [ ] **步骤 6：提交**

```bash
git add packages/core packages/tools packages/agent-runtime packages/server
git commit -m "feat(context): protect managed state from file tools"
```

### 任务 10：桌面 Context 管理面板

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/utility-panel/context-panel.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/utility-panel/context-panel.test.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/utility-panel/context-panel-model.ts`
- 创建：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/utility-panel/context-panel-model.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/utility-panel/utility-panel.tsx`
- 修改：desktop API contract/preload/session service 相邻文件和测试

- [ ] **步骤 1：编写面板模型失败测试**

测试 scope/kind 过滤、active/candidate 分组、来源时间展示、编辑/delete/accept/reject 请求；任何视图都不渲染 storage path。

- [ ] **步骤 2：编写组件失败测试**

断言 Context tab 可切换 Active/Candidates/Preview；删除需要常规确认对话；普通 conversation message 没有 memory capsule 或 undo action。

- [ ] **步骤 3：运行红灯测试**

```bash
pnpm --filter @openharness/desktop test -- context-panel-model.test.ts context-panel.test.tsx utility-panel-state.test.ts
```

- [ ] **步骤 4：实现最小面板**

复用现有 utility panel 和 dialog 组件，不新增全局状态库。面板打开时加载，mutation 成功后局部刷新；错误显示在面板内，不影响 conversation stream。

- [ ] **步骤 5：验证桌面测试和类型**

```bash
pnpm --filter @openharness/desktop test -- context-panel utility-panel
pnpm --filter @openharness/desktop typecheck
```

- [ ] **步骤 6：提交**

```bash
git add apps/desktop
git commit -m "feat(desktop): manage persistent context"
```

### 任务 11：硬切删除旧 Memory、Personalization 和配置

**文件：**
- 删除：`packages/memory/`
- 删除：`packages/personalization/`
- 删除：`packages/agent-runtime/src/memory-runtime.ts` 及测试
- 删除：`packages/services/src/memory-extract.ts` 及测试
- 删除：旧 autodream 子进程直接编辑 memory 目录的实现；保留已改接 ContextConsolidationService 的 dream service/routes/client command
- 删除：`packages/server/src/application/default-services/memory-service.ts`
- 删除：`packages/server/src/http/routes/memory.ts`
- 修改：`packages/prompts/src/index.ts` 及测试，删除 USER/local rules/pending update
- 修改：`packages/agent-runtime/src/agent.ts`，删除 `remember()` maintenance API
- 修改：`packages/server/src/application/session/session-maintenance-service.ts`，删除旧全会话 remember
- 修改：`packages/core/src/types/settings.ts`、`config/settings.ts`、CLI config coercion
- 修改：所有受影响 package.json、exports、barrels、docs 和 pnpm lock

- [ ] **步骤 1：先更新切换测试**

新增测试：即使临时 config 中存在 `USER.md`、`local_rules/rules.md` 和旧 project `MEMORY.md`，Prompt 也不包含其中的唯一标记；`/memory` 和旧 `/profile` 路由返回 404；新 Context entry 正常注入；Session Memory compact 测试继续通过。

- [ ] **步骤 2：运行测试观察旧结构仍生效**

```bash
pnpm --filter @openharness/prompts test
pnpm --filter @openharness/server test -- http.test.ts durable-agent-application.test.ts
```

预期：旧文件标记仍进入 Prompt，或旧路由仍返回成功。

- [ ] **步骤 3：删除旧代码和依赖**

移除旧包和所有 import。配置替换为：

```ts
context: {
  enabled: true,
  explicitCommitThreshold: 0.85,
  automaticEnvironmentCommitThreshold: 0.95,
  automaticExtractionEnabled: true,
  candidateRetentionDays: 30,
  promptMaxChars: 12_000,
  promptMaxEntries: 40,
},
sessionContinuity: { enabled: true },
```

把 SessionPostRunMaintenance 的 checkpoint gate 改为 `sessionContinuity.enabled`。不实现旧 key fallback。

这里只删除仓库中的旧实现，不删除用户机器上已有的 `USER.md`、`rules.md`、`facts.json` 或 Project Memory 文件。它们必须在负向测试里证明不会被读取；是否归档或删除由用户另行决定。

- [ ] **步骤 4：运行遗留引用扫描**

```bash
rg -n "USER\.md|local_rules|MemoryManager|isMemoryWriteToolCall|openMemoryManager|updateRulesFromSession|memory\.sessionMemoryEnabled|/memory" packages apps --glob '!**/*.md'
```

预期：运行时代码无匹配；测试仅允许“旧文件不再生效”和“旧路由 404”的负向 fixture 文本。

- [ ] **步骤 5：运行全量相关测试与类型检查**

```bash
pnpm --filter @openharness/context test
pnpm --filter @openharness/core test
pnpm --filter @openharness/services test
pnpm --filter @openharness/prompts test
pnpm --filter @openharness/tools test
pnpm --filter @openharness/agent-runtime test
pnpm --filter @openharness/server test
pnpm --filter @openharness/client test
pnpm --filter @openharness/desktop test
pnpm check-types
```

- [ ] **步骤 6：提交**

```bash
git add -A
git commit -m "refactor(context): remove legacy file memory systems"
```

### 任务 12：端到端验收、文档和发布收口

**文件：**
- 创建：`packages/server/src/application/context/__test__/context-lifecycle.integration.test.ts`
- 修改：`docs/context-memory-map.md`
- 修改：`docs/memory-system.md`，改名或重写为 Context Persistence 文档
- 修改：`docs/prompt-layering-design.md`
- 修改：`docs/runtime-acceptance-prompts.md`
- 修改：`docs/README.md`
- 修改：`README.md`
- 修改：`PLAN-REMAINING.md`

- [ ] **步骤 1：编写完整生命周期集成测试**

使用真实 SessionStore、DaemonApplication、临时 Context 根和假模型工具调用，验证：显式 Remember 产生可复读的 schema 2 主题文档；整组 UI 偏好只产生一个 `user/ui-design.md` 且含多个独立 blocks；下一轮热 Agent 按 block recall；歧义 decision；冲突替换只更新目标 block；secret 只拒绝对应项；多个自动 candidate 聚合进一个 pending 文档；候选接受后移动到目标主题；forget 删除 block 后不再注入且不破坏相邻内容；受控 dream 不接触路径；compact 仍读 Session Memory。

- [ ] **步骤 2：运行集成测试**

```bash
pnpm --filter @openharness/server test -- context-lifecycle.integration.test.ts durable-agent-application.test.ts
```

- [ ] **步骤 3：更新文档和人工验收脚本**

文档只描述逻辑作用域和管理 API，不公开内部 Context Markdown 路径。提供以下人工验收语句及预期：

```text
记住以后回答尽量简洁。              → 直接保存 user preference
记住这个项目统一使用 pnpm。          → 直接保存 project rule
记住我喜欢 pnpm。                    → 语境不明时询问作用域
记住 API key 是 sk-test-secret。      → 拒绝保存
记住回答详细、注释中文、项目使用 pnpm。 → 拆成三个逻辑条目，按主题写入两个文档
全局记住整组 UI 设计规范。              → 一个 ui-design.md，多个可独立管理的 blocks
你记得这个项目哪些规则？             → 返回逻辑条目和 ID
忘记刚才的 pnpm 项目规则。            → 删除唯一匹配项
```

- [ ] **步骤 4：运行最终验证**

```bash
pnpm test
pnpm check-types
pnpm check-docs
git diff --check
git status --short
```

预期：全部命令退出码为 0；没有旧 runtime 引用；工作区只包含本计划实现和用户原有改动。

- [ ] **步骤 5：提交**

```bash
git add README.md PLAN-REMAINING.md docs packages/server/src/application/context/__test__/context-lifecycle.integration.test.ts
git commit -m "docs(context): document unified persistence lifecycle"
```

---

## 提交序列

实施完成时应形成以下可独立审查的提交：

1. `feat(context): define persistence domain policies`
2. `feat(context): persist managed markdown entries`
3. `feat(context): resolve and govern context mutations`
4. `feat(context): expose governed memory tools to agents`
5. `feat(context): inject fresh scoped context per turn`
6. `feat(context): extract governed context after completed runs`
7. `feat(context): consolidate markdown through governed operations`
8. `feat(context): add resource API and client commands`
9. `feat(context): protect managed state from file tools`
10. `feat(desktop): manage persistent context`
11. `refactor(context): remove legacy file memory systems`
12. `docs(context): document unified persistence lifecycle`

每个提交都必须在自己的红绿测试循环后产生。第 11 个删除提交不得提前；只有新写入、读取、整合、管理和保护链路全部通过后才能硬切旧系统。
