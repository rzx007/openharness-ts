# 设计：MCP HTTP/SSE 传输 + headers 鉴权（C.3）

> 状态：已批准，待实现。

## 目标

MCP 客户端从「仅 stdio」补全到支持 **HTTP（streamable）+ SSE** 传输与 **headers 鉴权**，
对齐 Python（streamable_http + headers），并顺手修 resources 的 "Method not found" 处理。

## 现状

- `McpClientManager`（packages/mcp）只用 `StdioClientTransport`；`connectAll` 已有失败隔离。
- `McpServerConfig`（packages/core/src/types/settings.ts）= `{ command, args?, env? }`。
- SDK `@modelcontextprotocol/sdk@1.29.0` 提供 `StreamableHTTPClientTransport(url, { requestInit:{headers} })`
  与 `SSEClientTransport(url, { requestInit:{headers} })`。

## 设计

### 1. 扩展 `McpServerConfig`（向后兼容）
```ts
export interface McpServerConfig {
  type?: "stdio" | "http" | "sse"; // 显式优先
  // stdio
  command?: string;   // 现为必填 → 改为可选（http/sse 时不需要）
  args?: string[];
  env?: Record<string, string>;
  // http / sse
  url?: string;
  headers?: Record<string, string>;
}
```
- 推断：显式 `type` 优先；否则 `url`→http、`command`→stdio。
- `command` 由必填改可选（注意现有 stdio 调用方/类型不受影响）。

### 2. `connect` 按传输选择
- 抽一个纯函数 `resolveTransportKind(config): "stdio" | "http" | "sse" | { error }`（缺字段/冲突返回 error）。
- stdio：现有 `StdioClientTransport`（env 作 auth）。
- http：`new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } })`。
- sse：`new SSEClientTransport(new URL(config.url), { requestInit: { headers: config.headers } })`。
- 无效配置 → 设 `status:"error"`（不抛、不影响其他 server，沿用失败隔离）。

### 3. 连接元数据（对齐 Python）
- `McpConnection` 加 `transport: "stdio"|"http"|"sse"` 与 `authConfigured: boolean`
  （http/sse：`!!headers`；stdio：`!!env`）。
- `transports` map 值类型从 `StdioClientTransport` 放宽为 SDK `Transport`。

### 4. resources "Method not found"
- 现 `.catch(()=>[])` 吞所有错。改为：错误信息含 "Method not found"（server 不支持 resources）→ 正常返回 `[]`；其他错误记录到 connection（不致命）。

## 测试

- `resolveTransportKind`（纯函数）：url→http、command→stdio、type 显式优先、缺字段→error、http+SSE type 用 url。
- `connect`：mock SDK transport，断言 http 用 StreamableHTTPClientTransport 且 headers 进了 requestInit；sse 同理；stdio 不变。
- `authConfigured`：http+headers→true、stdio+env→true、无→false。
- resources：Method-not-found→[]、其他错误不崩。

## README

- 特性表「MCP 协议」🟡：stdio + **HTTP/SSE + headers 鉴权**；更新措辞。
- 配置示例补一个 http server（type/url/headers）。

## 范围外

- MCP 的 OAuth flow（McpAuth 工具占位）；运行时改配置 update_server_config。
