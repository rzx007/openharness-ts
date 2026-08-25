import type { OpenHarnessPluginPermissions } from "@openharness/plugins";

export interface NativeToolRegistration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  safeToRetry?: boolean;
}

export interface NativeToolCallContext {
  cwd: string;
  sessionId?: string;
  deadline: number;
}

export interface NativeToolHostRequest {
  type: "request";
  id: string;
  method: "healthcheck" | "registerTools" | "callTool" | "shutdown";
  payload?: unknown;
}

export interface NativeToolHostCancel {
  type: "cancel";
  id: string;
}

export interface NativeToolHostResponse {
  type: "response";
  id: string;
  result?: unknown;
  error?: { code: string; message: string; stack?: string };
}

export interface NativeToolHostLog {
  type: "log";
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

export interface RegisterToolsPayload {
  plugin: { id: string; name: string; version: string; root: string };
  entries: Array<{
    entryPath: string;
    permissions: OpenHarnessPluginPermissions;
  }>;
}
