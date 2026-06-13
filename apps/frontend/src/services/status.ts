/**
 * 解析后端 state_snapshot 的 status 字段。
 *
 * status 是 Record<string, unknown>（协议宽松），此前 App / Footer / Sidebar /
 * AppView 各自 String(status.x ?? ...) 解析，默认值还不统一。集中到这里：
 * mode 统一缺省 "default"，token 统一 Number(... ?? 0)。
 */
export interface ParsedStatus {
  /** 权限模式，缺省 "default" */
  mode: string;
  model: string;
  /** 推理强度（空串表示无） */
  effort: string;
  inputTokens: number;
  outputTokens: number;
}

export function parseStatus(status: Record<string, unknown>): ParsedStatus {
  return {
    mode: String(status.permission_mode ?? "default"),
    model: String(status.model ?? ""),
    effort: String(status.effort ?? ""),
    inputTokens: Number(status.input_tokens ?? 0),
    outputTokens: Number(status.output_tokens ?? 0),
  };
}
