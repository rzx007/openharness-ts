# Codex 插件转换器实现计划

> **面向 AI 代理的工作者：** 使用 superpowers 的计划执行、TDD 和完成前验证流程逐项推进，步骤使用复选框记录状态。

**目标：** Codex 本地插件能生成经过校验的 Native 目录，并通过现有 CLI 安装。

**架构：** 新增独立 Codex 解析器、MCP 映射器和转换器。复用 ConverterRegistry、摘要函数及 Native Validator/Installer，不向 Runtime 引入外部格式逻辑。

**技术栈：** TypeScript、Node.js 文件 API、Vitest。

## 1. 静态输入和转换测试

- [x] 新增 `packages/plugin-converters/fixtures/codex/` 的独立样本及来源说明。
- [x] 在 `src/codex/converter.test.ts` 使用真实临时目录，先断言注册表能识别 Codex，而现有实现不能。
- [x] 覆盖标准/custom Skills、资源保留、portable 身份和扩展优先级、MCP 与 unsupported 报告。

```ts
const { converter } = await createBuiltinConverterRegistry().detect(source, "codex");
expect(converter.id).toBe("codex");
const inspection = await converter.inspect(source);
const plan = await converter.plan(inspection);
await converter.convert({ inspection, plan, output, approvals: plan.items.filter(item => item.fidelity === "unsupported" || item.fidelity === "adapted").map(item => item.id) });
expect((await validateNativePlugin(output)).status).toBe("valid");
```

运行位置：`packages/plugin-converters`。命令：`node ../../node_modules/vitest/vitest.mjs run src/codex/converter.test.ts`。先确认缺少 Codex 注册导致失败，再实现。

## 2. 安全转换实现

- [x] `src/codex/source.ts`：manifest 选择、身份、路径校验和文件清单。
- [x] `src/codex/mcp.ts`：按服务器映射 Native 配置和权限，不支持的字段给出原因。
- [x] `src/codex/converter.ts`：计划、批准校验、重检输入、临时产物与审计文件、Native 校验和发布。
- [x] `src/index.ts` 导出并注册 Codex 转换器。
- [x] 测试拒绝源变化、计划篡改、路径逃逸、链接、已有输出和错误产物。

## 3. 安装与 CLI 验证

- [x] 在 `src/acceptance.test.ts` 增加真实安装、发现和加载测试，断言 origin、权限和资源可用。
- [x] 在 `apps/cli/src/commands/plugin.test.ts` 增加 `convert --from codex --dry-run --json` 和转换结果测试；CLI 帮助说明批准项。
- [x] 更新 `docs/plugins-contributions-design.md` 和首版使用说明，注明已支持与限制。
- [x] 运行转换器全部测试、相关 Native/CLI 测试、转换器类型检查、`git diff --check` 和文档链接检查。
- [x] 按 code review 流程审查本轮 diff，修复影响转换正确性或权限边界的问题。

基线：2026-09-09，转换器 4 个测试文件、6 项测试全部通过。当前 pnpm 启动器尝试联网获取工具版本，测试改为直接调用仓库已安装的 Vitest；Windows 沙箱读取 pnpm 链接依赖时出现 EPERM，已通过自动审批在沙箱外完成基线测试。

## 验证结果

- 转换器：6 个文件、31 项测试通过。
- Native 插件校验和安装：13 个文件、48 项测试通过。
- CLI 插件命令：10 项测试通过。
- 转换器 TypeScript 类型检查通过；文档检查通过（180 个 Markdown）；`git diff --check` 无格式错误。
- Figma 2.0.21、Plugin Management 0.1.0 真实插件静态转换与加载通过，分别得到 12 和 1 个 Skills，Apps 明确报告 unsupported。
- 独立代码审查提出的 5 项问题均通过真实文件回归复现并修复；定向复核无剩余阻塞项。

审查促成的必要调整：共享来源摘要增加无歧义 v2 编码；Native skills 改为逐个文件声明；portable 未知字段和第三方扩展需要批准；源文件过滤基于实际配置清单；仅生成 MCP 时检查目标路径冲突。没有修改 Native Runtime 的格式或安装状态模型。
