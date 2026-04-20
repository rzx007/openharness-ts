# OpenHarness-ts 后续计划

## 当前状态

Phase 1-14 全部完成（后端 26 packages + 前端 TUI），`pnpm build` + `pnpm test` 通过。
Provider 运行时切换功能已完成（/model 自动重检测 + /provider 命令 + RuntimeBundle class + Settings.apiKeys）。

---

## P0: 端到端集成验证

### 1. ✅ BackendHost 冒烟测试
- 为 `runBackendHost` 写集成测试（mock QueryEngine）
- 验证 OHJSON: 协议的序列化/反序列化
- 验证权限请求/响应的 Future 解析

### 2. handleLine 命令路由
- 后端识别 `/help`, `/model`, `/clear`, `/compact`, `/exit` 等斜杠命令
- 命令输出通过 `transcript_item { role: "system" }` 事件返回
- 退出命令通过返回 `should_continue = false` 触发 shutdown

---

## P1: 前端增强

### 3. Markdown 渲染
- 引入 `marked` + `cli-highlight` 依赖
- 在 ConversationView 中渲染 markdown：标题、列表、代码块（语法高亮）
- 处理 ANSI 转义序列和终端宽度适配

### 4. 多主题支持
- 将 `@openharness/themes` 包的 5 主题（default/dark/minimal/cyberpunk/solarized）接入前端 builtinThemes.ts
- 测试各主题在终端中的颜色渲染效果

### 5. /resume 会话列表
- 后端 `list_sessions` 需要读取 `~/.openharness/sessions/` 目录
- 实现 `list_session_snapshots` 函数（读取 session JSON，提取 id/message_count/created_at/summary）
- 前端 SelectModal 展示会话列表

---

## P2: 功能完善

### 6. AskUser 工具 → question modal
- 后端 `runBackendHost` 处理 `askUser` 工具调用
- 发出 `modal_request { kind: "question" }` 事件
- 前端 QuestionModal 接收 answer 后回传 `question_response`

### 7. MCP Auth 流程
- 后端检测 MCP server 需要 auth 时发出 `modal_request { kind: "mcp_auth" }` 事件
- 前端 ModalHost 的 mcp_auth 分支处理
- 验证 OAuth Device Code 流程在 TUI 模式下工作

### 8. Swarm 事件
- 后端 TaskManager 和 SwarmManager 在工具执行时发出 swarm_status 事件
- 前端 SwarmPanel 展示 teammate 状态和 notification

### 9. 斜杠命令补全增强
- `/permissions show` → 模式选择器
- `/plan on|off` → plan mode 切换
- `/theme set <name>` → 主题切换
- 更多命令的 TUI 本地处理（减少后端往返）

---

## P3: 后端增强

### 10. AppState 实时更新
- `buildStatePayload` 目前使用静态 settings，需追踪运行时状态
- 追踪 input_tokens / output_tokens（从 CostTracker 获取）
- 追踪 MCP 连接状态
- 追踪 model / permission_mode 变更

### 11. 流式事件增强
- `usage` 事件 → 更新 state_snapshot 的 token 计数
- `complete` 事件 → 触发 assistant_complete
- `error` 事件 → 转为 BackendEvent error

---

## P4: 质量与测试

### 12. 前端组件测试
- 使用 ink-testing-library 为核心组件写测试
- 测试 ConversationView 消息渲染
- 测试 PromptInput busy/idle 状态
- 测试 StatusBar 格式化

### 13. 端到端测试脚本
- 写一个自动化脚本：启动 backend-only → 发送 JSON requests → 验证 OHJSON responses
- 覆盖正常对话流、权限拒绝流、错误恢复流

---

## P5: 体验优化

### 14. 终端宽度适配
- 检测终端列数，截断/换行过长文本
- ToolCallDisplay 摘要适配窄终端
- StatusBar 适配窄终端（隐藏低优先级字段）

### 15. 历史搜索
- Ctrl+R 历史搜索（类似 bash reverse-i-search）
- 命令历史持久化到文件

### 16. 多行输入
- Shift+Enter 换行支持
- 多行文本在 PromptInput 中的滚动显示

### 17. 错误恢复
- 后端进程崩溃时自动重启
- 网络断开时重连提示
- API 限流时的等待动画

---

## 时间线建议

| 优先级 | 任务 | 预估 |
|--------|------|------|
| P0 | BackendHost 测试 + handleLine | 1-2 天 |
| P1 | Markdown + 主题 + resume | 2-3 天 |
| P2 | AskUser + MCP Auth + Swarm + 命令 | 3-5 天 |
| P3 | AppState + 流式增强 | 2-3 天 |
| P4 | 组件测试 + E2E | 3-5 天 |
| P5 | 终端适配 + 历史 + 多行 + 恢复 | 3-5 天 |

**建议顺序：P0 → P1 → P2 → P3 → P4 → P5，每个 P 完成后验证 build + test 通过。**
