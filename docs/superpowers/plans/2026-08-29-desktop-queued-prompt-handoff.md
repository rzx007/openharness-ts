# 桌面端排队消息自动接管展示实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 排队消息自动成为下一轮时，立即在对话正文显示该用户消息，不再只显示“正在处理”。

**架构：** 在桌面端对话页从权威 input/pending run 派生一个自动接管中的乐观提交，再复用现有 `mergeOptimisticTranscript` 合并到正文。真实用户消息到达后按 input ID 去重，由权威转录接管。

**技术栈：** React 19、TypeScript、Vitest、Zustand

---

### 任务 1：补齐自动接管的乐观正文消息

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/optimistic-transcript.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/conversation-page.tsx`
- 测试：`apps/desktop/src/renderer/src/components/desktop/conversation-page/optimistic-transcript.test.ts`

- [x] **步骤 1：编写失败的测试**

新增测试：给定一个没有对应正文消息的权威 input 和自动接管中的 pending run，派生结果必须生成 `placement: "transcript"` 的乐观提交；已有真实用户消息或仍有其他 running run 时不生成。

- [x] **步骤 2：运行测试验证失败**

运行：

```powershell
.\node_modules\.bin\vitest.CMD run --config apps\desktop\vitest.config.ts apps\desktop\src\renderer\src\components\desktop\conversation-page\optimistic-transcript.test.ts
```

预期：FAIL，原因是自动接管派生函数尚不存在或没有返回乐观提交。

- [x] **步骤 3：编写最少实现代码**

在 `optimistic-transcript.ts` 增加一个纯函数，从 messages、inputs 和 runs 中找出“无 running run 时最早的 pending run”，在缺少对应用户消息时返回可供 `mergeOptimisticTranscript` 使用的乐观提交。对话页把该结果与本地提交一起传入合并函数。

- [x] **步骤 4：运行测试验证通过**

重新运行步骤 2 的命令，预期新增测试全部 PASS。

- [x] **步骤 5：运行桌面端相关回归测试**

运行：

```powershell
.\node_modules\.bin\vitest.CMD run --config apps\desktop\vitest.config.ts apps\desktop\src\renderer\src\components\desktop\conversation-page apps\desktop\src\renderer\src\stores\desktop-session
```

预期：全部 PASS。

- [x] **步骤 6：运行类型检查并审查差异**

运行桌面端 web 类型检查，确认新增派生数据符合 `PendingPromptSubmission` 和共享会话类型；然后检查 `git diff --check` 与最终差异。
