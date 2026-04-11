# @openharness/tools

Tool registry with built-in tools for file operations, shell execution, web requests, and more.

## 已注册工具 (15)

### Shell
- `Bash` - Execute bash commands

### File
- `Read` - Read file contents
- `Write` - Write file contents
- `Edit` - Edit file (replace)
- `Glob` - File glob matching

### Search
- `Grep` - Text search in files

### Web
- `WebFetch` - HTTP fetch
- `WebSearch` - Web search

### Meta
- `TodoWrite` - Append to TODO file
- `Config` - Read/update settings
- `Sleep` - Sleep for N seconds
- `Skill` - Read skill content
- `ToolSearch` - Search tools
- `AskUser` - Ask user question
- `Brief` - Truncate text

## 使用

```ts
import { createDefaultToolRegistry } from "@openharness/tools";

const registry = createDefaultToolRegistry();
const tools = registry.getAll();
```

## 扩展

```ts
registry.register({
  name: "MyTool",
  description: "My custom tool",
  inputSchema: { type: "object", properties: {} },
  execute: async (input, context) => {
    return { content: [{ type: "text", text: "result" }] };
  }
});
```

## 测试

```bash
pnpm --filter @openharness/tools test
```