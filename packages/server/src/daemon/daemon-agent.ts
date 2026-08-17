import {
  createOpenHarnessAgent,
  type OpenHarnessAgent,
  type OpenHarnessAgentOptions,
} from "@openharness/agent-runtime";
import { join } from "node:path";
import {
  getCoordinatorSystemPrompt,
  getCoordinatorTools,
  getCoordinatorUserContext,
} from "@openharness/coordinator";
import type {
  AgentCronEffects,
  AgentEffects,
  AgentEventListener,
  Settings,
} from "@openharness/core";
import type { AgentTerminalHost } from "@openharness/terminal";
import type { AgentJobHost } from "@openharness/jobs";
import { readSessionRuntimeConfig } from "@openharness/services";
import type {
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
} from "@openharness/services/session-runtime/types";

import { transcriptToAgentMessages } from "../http/agent/agent-transcript.js";

export interface CreateDaemonAgentContext {
  session: SessionRecord;
  history: SessionMessageRecord[];
  parts: SessionMessagePartRecord[];
  options: OpenHarnessAgentOptions;
}

/** Low-level creation seam used by tests and embedded hosts. */
export type CreateDaemonAgent = (
  context: CreateDaemonAgentContext,
) => Promise<OpenHarnessAgent>;

export interface LoadDaemonAgentContext {
  session: SessionRecord;
  history: SessionMessageRecord[];
  parts: SessionMessagePartRecord[];
}

/** Produces a fully initialized daemon-owned Agent for one durable session. */
export type LoadDaemonAgent = (
  context: LoadDaemonAgentContext,
) => Promise<OpenHarnessAgent>;

export interface DaemonAgentLoaderOptions {
  settings?: Settings;
  getSettings?: () => Settings;
  getSettingsForCwd?: (cwd: string) => Promise<Settings> | Settings;
  createAgent?: CreateDaemonAgent;
  requestPermission?: AgentEffects["requestPermission"];
  cron?: AgentCronEffects;
  createTerminalHost?(session: SessionRecord): AgentTerminalHost;
  createJobHost?(session: SessionRecord): AgentJobHost;
  createEventSink?(
    agent: OpenHarnessAgent,
    session: SessionRecord,
  ): AgentEventListener;
}

/**
 * Owns the only durable-session -> live-Agent translation in the daemon.
 * The returned loader also restores transcript history before exposing the Agent.
 */
export function createDaemonAgentLoader(
  options: DaemonAgentLoaderOptions,
): LoadDaemonAgent | undefined {
  if (
    !options.createAgent &&
    !options.settings &&
    !options.getSettings &&
    !options.getSettingsForCwd
  )
    return undefined;

  return async ({ session, history, parts }) => {
    const settings = await resolveSettingsForSession(options, session.cwd);
    if (!options.createAgent && !settings)
      throw new Error("Agent settings are not configured");

    let eventSink: AgentEventListener | undefined;
    let sinkBinding: Promise<void> | undefined;
    const pendingEvents: Parameters<AgentEventListener>[0][] = [];
    const agentOptions: OpenHarnessAgentOptions = {
      ...(settings ? { settings } : {}),
      cwd: session.cwd,
      sessionId: session.id,
      ...agentConfigurationFromSession(session, settings),
      ...(options.requestPermission
        ? { requestPermission: options.requestPermission }
        : {}),
      ...(options.cron ? { cron: options.cron } : {}),
      ...(options.createTerminalHost
        ? { terminal: options.createTerminalHost(session) }
        : {}),
      ...(options.createJobHost ? { jobs: options.createJobHost(session) } : {}),
      ...(options.createEventSink
        ? {
            onEvent: async (event) => {
              if (!eventSink) {
                pendingEvents.push(event);
                return;
              }
              await sinkBinding;
              await eventSink(event);
            },
          }
        : {}),
    };
    const agent = options.createAgent
      ? await options.createAgent({
          session,
          history,
          parts,
          options: agentOptions,
        })
      : await createOpenHarnessAgent(agentOptions);
    try {
      agent.loadHistory(transcriptToAgentMessages(history, parts));
      eventSink = options.createEventSink?.(agent, session);
      if (eventSink && pendingEvents.length > 0) {
        const sink = eventSink;
        sinkBinding = (async () => {
          for (const event of pendingEvents) await sink(event);
          pendingEvents.length = 0;
        })();
        await sinkBinding;
        sinkBinding = undefined;
      }
      return agent;
    } catch (error) {
      try {
        await agent.close();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Daemon Agent initialization and cleanup failed: ${session.id}`,
        );
      }
      throw error;
    }
  };
}

async function resolveSettingsForSession(
  options: DaemonAgentLoaderOptions,
  cwd: string,
): Promise<Settings | undefined> {
  return (
    (await options.getSettingsForCwd?.(cwd)) ??
    options.getSettings?.() ??
    options.settings
  );
}

function agentConfigurationFromSession(
  session: SessionRecord,
  settings: Settings | undefined,
): Partial<OpenHarnessAgentOptions> {
  const runtime = readSessionRuntimeConfig(session, {
    provider: settings?.provider,
    baseUrl: settings?.baseUrl,
    apiFormat: settings?.apiFormat,
    permissionMode: settings?.permission?.mode,
    maxTurns: settings?.maxTurns,
    effort: settings?.effort,
    sessionMode: "direct",
  });
  const configuration: Partial<OpenHarnessAgentOptions> = {
    model: runtime.model,
    provider: runtime.provider,
    baseUrl: runtime.baseUrl,
    apiFormat: runtime.apiFormat,
    permissionMode: runtime.permissionMode,
    systemPrompt: runtime.systemPrompt,
    maxTurns: runtime.maxTurns,
    allowedTools: runtime.allowedTools,
    disallowedTools: runtime.disallowedTools,
    effort: runtime.effort,
  };
  if (runtime.sessionMode === "coordinator") {
    configuration.systemPrompt = coordinatorSystemPrompt({
      settings,
      cwd: session.cwd,
      sessionPrompt: configuration.systemPrompt,
      hostToolCeiling:
        configuration.allowedTools ?? settings?.permission.allowedTools,
    });
    configuration.roleAllowedTools = getCoordinatorTools();
  }
  return configuration;
}

function coordinatorSystemPrompt(options: {
  settings: Settings | undefined;
  cwd: string;
  sessionPrompt: string | undefined;
  hostToolCeiling: string[] | undefined;
}): string {
  const sections = [getCoordinatorSystemPrompt()];
  const mcpClients = Object.keys(options.settings?.mcpServers ?? {})
    .sort()
    .map((name) => ({ name }));
  const context = getCoordinatorUserContext(
    mcpClients,
    join(options.cwd, ".openharness", "scratchpad"),
    {
      enabled: true,
      hostToolCeiling: options.hostToolCeiling,
    },
  );
  if (context.workerToolsContext?.trim()) {
    sections.push(`## Runtime Context\n\n${context.workerToolsContext.trim()}`);
  }
  if (options.sessionPrompt?.trim()) {
    sections.push(
      `## Additional Session Instructions\n\n${options.sessionPrompt.trim()}`,
    );
  }
  return sections.join("\n\n");
}
