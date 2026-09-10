// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { toMcpForm } from "./mcp-config"
import { McpFormFields } from "./mcp-form"

describe("McpFormFields layout", () => {
  let root: Root
  let host: HTMLDivElement

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT
  })

  async function render(type: "stdio" | "http" = "stdio"): Promise<void> {
    const value = toMcpForm({
      name: "",
      config: type === "stdio" ? { type, command: "" } : { type, url: "" },
    })
    await act(async () => {
      root.render(
        <McpFormFields value={value} error="" errorId="mcp-error" onChange={() => undefined} />
      )
    })
  }

  it("renders the STDIO form as two cards with short labels and placeholders", async () => {
    await render()

    expect(host.textContent).toContain("名称")
    expect(host.textContent).toContain("类型")
    expect(host.textContent).toContain("启动命令")
    expect(host.textContent).toContain("参数")
    expect(host.textContent).toContain("环境变量")
    expect(host.textContent).toContain("环境变量传递")
    expect(host.textContent).toContain("工作目录")
    expect(host.textContent).toContain("STDIO")
    expect(host.textContent).toContain("流式 HTTP")
    expect(host.querySelector('input[placeholder="MCP server name"]')).not.toBeNull()
    expect(host.querySelector('input[placeholder="openai-dev-mcp serve-sqlite"]')).not.toBeNull()
    expect(host.querySelector('input[placeholder="~/code"]')).not.toBeNull()
    expect(host.textContent).toContain("添加参数")
    expect(host.textContent).toContain("添加环境变量")
    expect(host.textContent).toContain("添加变量")
    expect(host.textContent).not.toContain("必填")
    expect(host.textContent).not.toContain("连接类型")
    expect(host.textContent).not.toContain("透传环境变量")
    expect(host.textContent).not.toContain("其他 JSON 字段")
    expect(host.querySelectorAll("[data-mcp-form-card]")).toHaveLength(2)
  })

  it("renders the HTTP form with URL, bearer token and header rows", async () => {
    await render("http")

    expect(host.textContent).toContain("URL")
    expect(host.textContent).toContain("Bearer 令牌环境变量")
    expect(host.textContent).toContain("标头")
    expect(host.textContent).toContain("来自环境变量的标头")
    expect(host.querySelector('input[placeholder="https://mcp.example.com/mcp"]')).not.toBeNull()
    expect(host.querySelector('input[placeholder="MCP_BEARER_TOKEN"]')).not.toBeNull()
    expect(host.textContent).toContain("添加标头")
    expect(host.textContent).not.toContain("HTTP 请求头")
    expect(host.textContent).not.toContain("请求头环境变量")
  })
})
