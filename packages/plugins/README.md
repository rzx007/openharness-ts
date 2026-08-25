# @openharness/plugins

OpenHarness Native Plugin 的校验、组件加载、安装状态、版本 cache 与激活基础设施。

Runtime 只接受插件根目录中的 `.openharness-plugin/plugin.json`。Claude Code、Codex 等外部格式不在本包解析，必须先由 `@openharness/plugin-converters` 转为 Native Plugin。

当前 Native v1 可加载 Skills、Agents、Hooks、MCP 和 Node Tool。Tool 模块只会在独立子进程中加载；插件元数据加载阶段不会 import 第三方代码。Wasm Tool 目前只校验和提示，不会激活。

Node Tool 入口必须导出 `registerTools(context)`，并返回 Tool 定义数组。每个定义包含 `name`、`description`、`inputSchema` 和 `invoke(input, context)`；`invoke` 返回标准的 `{ content: [...] }` Tool 结果。一个插件版本共用一个 Tool Host 子进程，Agent Runtime 关闭或 Host 崩溃时会注销该插件注册的全部 Tool。

当前子进程边界可以隔离崩溃和 daemon 的环境变量，但还不是操作系统级沙箱。第三方 Node 代码仍可直接调用 Node 文件、网络和进程 API；不要把 manifest 权限误解为完整的系统调用拦截。

```bash
pnpm --filter @openharness/plugins test
pnpm --filter @openharness/plugins check-types
```
