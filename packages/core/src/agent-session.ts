import { randomUUID } from "node:crypto";

import type {
  AgentPermissionDecision,
  AgentPermissionRequest,
  AgentRunHost,
  AgentRunScope,
  AgentRuntimeEvent,
  QueryEngine as IQueryEngine,
} from "./types/runtime.js";
import type {
  ContentBlock,
  Message,
} from "./types/messages.js";
import type { StreamEvent } from "./types/events.js";

export interface AgentSessionSubmitOptions {
  signal?: AbortSignal;
  pullFollowUps?: () => string[] | Promise<string[]>;
  host?: AgentRunHost;
}

export interface AgentSessionRunResult {
  output: string;
  events: StreamEvent[];
  history: Message[];
}

export interface AgentSessionHostCallbacks {
  emitEvent?(event: AgentRuntimeEvent): void | Promise<void>;
  emitStreamEvent?(event: StreamEvent): void | Promise<void>;
  requestPermission?(request: AgentPermissionRequest): Promise<AgentPermissionDecision>;
}

export interface AgentSessionOptions extends AgentSessionHostCallbacks {
  queryEngine: IQueryEngine;
  cwd: string;
  sessionId?: string;
}

export class AgentSession {
  private readonly sessionId: string;
  private inputCounter = 0;
  private runCounter = 0;

  constructor(private readonly options: AgentSessionOptions) {
    this.sessionId = options.sessionId ?? `agent_session_${randomUUID()}`;
    this.options.queryEngine.setSessionId(this.sessionId);
  }

  get id(): string {
    return this.sessionId;
  }

  async *submitMessage(
    content: string | ContentBlock[],
    options: AgentSessionSubmitOptions = {},
  ): AsyncIterable<StreamEvent> {
    const host = options.host ?? this.createHost(options.signal);
    for await (const event of this.options.queryEngine.submitMessage(content, {
      signal: options.signal,
      pullFollowUps: options.pullFollowUps,
      runtimeHost: host,
    })) {
      await host.emitStreamEvent(event);
      yield event;
    }
  }

  async runMessage(
    content: string | ContentBlock[],
    options: AgentSessionSubmitOptions = {},
  ): Promise<AgentSessionRunResult> {
    const events: StreamEvent[] = [];
    let output = "";
    for await (const event of this.submitMessage(content, options)) {
      events.push(event);
      if (event.type === "text_delta") output += event.delta;
    }
    return {
      output,
      events,
      history: this.options.queryEngine.getHistory(),
    };
  }

  getHistory(): Message[] {
    return this.options.queryEngine.getHistory();
  }

  clear(): void {
    this.options.queryEngine.clear();
  }

  createHost(signal?: AbortSignal): AgentRunHost {
    const scope = this.createScope(signal);
    return {
      scope,
      emitEvent: async (event) => {
        await this.options.emitEvent?.(event);
      },
      emitStreamEvent: async (event) => {
        await this.options.emitStreamEvent?.(event);
      },
      requestPermission: async (request) => {
        return await (this.options.requestPermission?.(request) ?? {
          status: "denied",
          reason: "No permission handler configured",
        });
      },
      spawnChildAgent: async () => {
        throw new Error("Child agents are not supported by this AgentSession host");
      },
      sendChildInput: async () => {
        throw new Error("Child agents are not supported by this AgentSession host");
      },
      interruptChildAgent: async () => {
        throw new Error("Child agents are not supported by this AgentSession host");
      },
      awaitChildAgent: async () => {
        throw new Error("Child agents are not supported by this AgentSession host");
      },
    };
  }

  private createScope(signal?: AbortSignal): AgentRunScope {
    this.inputCounter += 1;
    this.runCounter += 1;
    return {
      sessionId: this.sessionId,
      inputId: `input_${this.inputCounter}`,
      runId: `run_${this.runCounter}`,
      cwd: this.options.cwd,
      traceId: randomUUID(),
      signal: signal ?? new AbortController().signal,
    };
  }
}

export function createAgentSession(options: AgentSessionOptions): AgentSession {
  return new AgentSession(options);
}
