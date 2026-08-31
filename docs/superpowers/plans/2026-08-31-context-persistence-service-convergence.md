# Context Persistence 服务收口实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 Agent、HTTP/Desktop 和候选管理入口通过同一个 `ContextPersistenceService` 执行全部受治理 Context 操作，daemon 只保留作用域解析与依赖注入。

**架构：** 扩展现有服务，不新增 facade。服务接收 `ContextRuntimeScope` 并统一 list/get/recall/update/forget/resolve；`ContextResourceService` 和 daemon Host adapter 只转换输入输出。`ContextQueryService` 继续专用于 Prompt 检索。

**技术栈：** TypeScript、Vitest、MarkdownContextStore、OpenHarness Host Capability。

---

### 任务 1：固定统一服务契约

**文件：**
- 修改：`packages/server/src/application/context/__test__/context-persistence-service.test.ts`
- 修改：`packages/server/src/application/context/context-persistence-service.ts`

- [x] **步骤 1：编写失败测试**

增加真实 store 测试：调用 `service.recall/update/forget/resolve`，断言作用域隔离、公开字段、敏感信息拒绝、candidate 状态迁移和 not-found 结果。

- [x] **步骤 2：验证红灯**

运行：`pnpm test -- context-persistence-service.test.ts --reporter=dot`

预期：FAIL，报告新增方法不存在。

- [x] **步骤 3：实现最少服务代码**

在 `ContextPersistenceService` 内加入 scope refs、逻辑 ID locate、公开字段转换及六个操作；复用现有敏感度、内容规范化和 topic 路由函数。

- [x] **步骤 4：验证绿灯**

运行同一测试命令，预期全部 PASS。

### 任务 2：让所有入口只做适配

**文件：**
- 修改：`packages/server/src/application/context/context-resource-service.ts`
- 修改：`packages/server/src/application/daemon-application.ts`
- 修改：`packages/server/src/application/context/__test__/context-lifecycle.integration.test.ts`

- [x] **步骤 1：增加入口一致性断言并验证红灯**

构造不暴露 store 的 `ContextPersistenceService` 依赖，确认资源服务仍能 list/update/remove/accept/reject；该测试会因当前资源服务直接读取 store 而失败。

- [x] **步骤 2：瘦身适配器**

资源服务只解析 runtime scope 并委托；daemon Host 的五个方法只验证 session、解析 runtime scope、调用统一服务。删除 daemon 中 `contextScopeRefs`、`findContextEntry`、`publicContextEntry` 和 `isContextTopic`。

- [x] **步骤 3：运行相关测试**

运行 Context service、生命周期和 context route 测试，预期全部 PASS。

### 任务 3：文档、完整验证与提交

**文件：**
- 修改：`docs/context-memory-map.md`
- 修改：`docs/memory-system.md`
- 修改：`PLAN-REMAINING.md`

- [x] **步骤 1：记录最终所有权边界**

明确 daemon 是资源 owner、ContextPersistenceService 是唯一治理入口、agent-runtime 是 capability consumer。

- [x] **步骤 2：运行验证**

运行 server 全量测试、全仓 `turbo check-types`、`node scripts/check-docs.mjs` 和 `git diff --check`，确认零失败。

- [x] **步骤 3：提交**

只暂存本计划涉及的文件，创建独立提交：`refactor(context): converge persistence operations`。
