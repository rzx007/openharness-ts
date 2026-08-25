import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ToolResult } from "@openharness/core";
import type { LoadedNativePlugin } from "@openharness/plugins";
import type {
  NativeToolCallContext,
  NativeToolHostLog,
  NativeToolHostResponse,
  NativeToolRegistration,
  RegisterToolsPayload,
} from "./protocol.js";

export type NativeToolHostState = "inactive" | "starting" | "active" | "degraded" | "error";

export class NativeToolHostError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NativeToolHostError";
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  removeAbortListener?: () => void;
}

export interface NativeToolHostOptions {
  registrationTimeoutMs?: number;
  callTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  onLog?: (event: NativeToolHostLog) => void;
  onCrash?: (error: NativeToolHostError) => void;
}

export class NativeToolHost {
  private child: ChildProcess | undefined;
  private pending = new Map<string, PendingRequest>();
  private stopping = false;
  state: NativeToolHostState = "inactive";

  constructor(
    readonly plugin: LoadedNativePlugin,
    private readonly options: NativeToolHostOptions = {},
  ) {}

  async start(): Promise<NativeToolRegistration[]> {
    if (this.child) throw new NativeToolHostError("tool_protocol_error", "Native Tool Host is already started");
    const entries = this.plugin.components.tools?.value ?? [];
    if (entries.length === 0) return [];
    this.state = "starting";
    const hostEntry = new URL("./host-entry.mjs", import.meta.url);
    const inheritedEnv = ["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG"]
      .reduce<NodeJS.ProcessEnv>((result, key) => {
        if (process.env[key] !== undefined) result[key] = process.env[key];
        return result;
      }, {});
    const child = fork(hostEntry, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "advanced",
      // Do not leak daemon API keys or other ambient secrets into third-party code.
      env: { ...inheritedEnv, OPENHARNESS_NATIVE_TOOL_HOST: "1" },
    });
    this.child = child;
    child.on("message", (message) => this.handleMessage(message));
    child.on("error", (error) => this.handleCrash(new NativeToolHostError("tool_host_spawn_failed", error.message, { cause: error })));
    child.on("exit", (code, signal) => {
      if (!this.stopping) this.handleCrash(new NativeToolHostError("tool_host_crashed", `Native Tool Host exited (code=${code ?? "none"}, signal=${signal ?? "none"})`));
    });
    child.stderr?.on("data", (chunk) => this.options.onLog?.({ type: "log", level: "error", message: String(chunk).trimEnd() }));
    child.stdout?.on("data", (chunk) => this.options.onLog?.({ type: "log", level: "info", message: String(chunk).trimEnd() }));

    try {
      await this.request("healthcheck", undefined, this.options.registrationTimeoutMs ?? 10_000);
      const payload: RegisterToolsPayload = {
        plugin: {
          id: this.plugin.manifest.id,
          name: this.plugin.manifest.name,
          version: this.plugin.manifest.version,
          root: this.plugin.root,
        },
        entries: entries.map((entry) => ({ entryPath: entry.entryPath, permissions: entry.effectivePermissions })),
      };
      const registrations = await this.request("registerTools", payload, this.options.registrationTimeoutMs ?? 10_000);
      if (!Array.isArray(registrations)) throw new NativeToolHostError("tool_protocol_error", "Tool Host returned an invalid registration result");
      this.state = "active";
      return registrations as NativeToolRegistration[];
    } catch (error) {
      this.state = "error";
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  async call(
    name: string,
    input: Record<string, unknown>,
    context: Omit<NativeToolCallContext, "deadline">,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (this.state !== "active") throw new NativeToolHostError("tool_host_unavailable", `Native Tool Host is ${this.state}`);
    const timeoutMs = this.options.callTimeoutMs ?? 60_000;
    return await this.request("callTool", {
      name,
      input,
      context: { ...context, deadline: Date.now() + timeoutMs },
    }, timeoutMs, signal) as ToolResult;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) { this.state = "inactive"; return; }
    this.stopping = true;
    try {
      if (child.connected) await this.request("shutdown", undefined, this.options.shutdownTimeoutMs ?? 2_000);
    } catch {
      // The forced kill below is the final lifecycle boundary.
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      this.rejectPending(new NativeToolHostError("tool_host_stopped", "Native Tool Host stopped"));
      this.child = undefined;
      this.state = "inactive";
    }
  }

  stopSync(): void {
    this.stopping = true;
    this.child?.kill();
    this.child = undefined;
    this.state = "inactive";
  }

  private request(method: "healthcheck" | "registerTools" | "callTool" | "shutdown", payload: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const child = this.child;
    if (!child?.connected) return Promise.reject(new NativeToolHostError("tool_host_unavailable", "Native Tool Host IPC is unavailable"));
    if (signal?.aborted) return Promise.reject(new NativeToolHostError("tool_call_cancelled", "Native Tool call was cancelled"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        child.send({ type: "cancel", id });
        reject(new NativeToolHostError(method === "callTool" ? "tool_call_timeout" : "tool_protocol_timeout", `${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      const pending: PendingRequest = { resolve, reject, timer };
      if (signal) {
        const onAbort = () => {
          this.pending.delete(id);
          clearTimeout(timer);
          child.send({ type: "cancel", id });
          reject(new NativeToolHostError("tool_call_cancelled", "Native Tool call was cancelled"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }
      this.pending.set(id, pending);
      child.send({ type: "request", id, method, payload }, (error) => {
        if (!error) return;
        this.finishPending(id, undefined, new NativeToolHostError("tool_protocol_error", error.message, { cause: error }));
      });
    });
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    if ((message as NativeToolHostLog).type === "log") {
      this.options.onLog?.(message as NativeToolHostLog);
      return;
    }
    const response = message as NativeToolHostResponse;
    if (response.type !== "response" || typeof response.id !== "string") return;
    const error = response.error
      ? new NativeToolHostError(response.error.code, response.error.message)
      : undefined;
    this.finishPending(response.id, response.result, error);
  }

  private finishPending(id: string, value: unknown, error?: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.removeAbortListener?.();
    if (error) pending.reject(error); else pending.resolve(value);
  }

  private handleCrash(error: NativeToolHostError): void {
    if (this.state === "error" && !this.child) return;
    this.state = "error";
    this.rejectPending(error);
    this.child = undefined;
    this.options.onCrash?.(error);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.removeAbortListener?.();
      pending.reject(error);
    }
  }
}
