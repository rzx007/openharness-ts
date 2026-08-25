# @openharness/plugins

OpenHarness Native Plugin 的校验、组件加载、安装状态、版本 cache 与激活基础设施。

Runtime 只接受插件根目录中的 `.openharness-plugin/plugin.json`。Claude Code、Codex 等外部格式不在本包解析，必须先由 `@openharness/plugin-converters` 转为 Native Plugin。

当前 Native v1 可加载 Skills、Agents、Hooks 和 MCP。Tool 声明可被识别，但隔离执行环境完成前不会 import 或激活。

```bash
pnpm --filter @openharness/plugins test
pnpm --filter @openharness/plugins check-types
```
