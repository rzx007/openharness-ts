import {
  OpenHarnessClient,
  createPromptRequestId,
  hasActiveRun,
  syncEvents,
  type OpenHarnessClientState,
  type SessionEventRecord,
  type SessionMessagePartRecord,
} from "@openharness/client";
import type { Settings } from "@openharness/core";

import { ensureLocalDaemon } from "./ensure-daemon.js";
import { EventRenderer } from "./renderer.js";

export interface PrintSessionOptions {
  model?: string;
  cwd?: string;
  verbose?: boolean;
  outputFormat?: string;
  dangerouslySkipPermissions?: boolean;
  permissionMode?: string;
  maxTurns?: number;
  systemPrompt?: string;
  allowedTools?: string;
  disallowedTools?: string;
  effort?: string;
  continue?: boolean;
  resume?: string;
}

/** Build daemon session.metadata from CLI overrides / settings. */
export function buildPrintSessionMetadata(
  settings: Settings,
  options: PrintSessionOptions,
): Record<string, unknown> {
  const permissionMode = options.dangerouslySkipPermissions
    ? "full_auto"
    : options.permissionMode ?? settings.permission?.mode;
  const maxTurns = options.maxTurns ?? settings.maxTurns;
  const systemPrompt = options.systemPrompt ?? settings.systemPrompt;
  const effort = options.effort ?? settings.effort;
  const allowedTools = options.allowedTools
    ? options.allowedTools.split(",").map((tool) => tool.trim()).filter(Boolean)
    : undefined;
  const disallowedTools = options.disallowedTools
    ? options.disallowedTools.split(",").map((tool) => tool.trim()).filter(Boolean)
    : undefined;

  const metadata: Record<string, unknown> = {};
  if (typeof permissionMode === "string" && permissionMode) metadata.permissionMode = permissionMode;
  if (typeof maxTurns === "number") metadata.maxTurns = maxTurns;
  if (typeof systemPrompt === "string" && systemPrompt) metadata.systemPrompt = systemPrompt;
  if (allowedTools && allowedTools.length > 0) metadata.allowedTools = allowedTools;
  if (disallowedTools && disallowedTools.length > 0) metadata.disallowedTools = disallowedTools;
  if (typeof effort === "string" && effort) metadata.effort = effort;
  return metadata;
}

/**
 * Reject legacy project-level snapshot flags until daemon resume is wired.
 */
export function rejectPrintContinueResume(options: Pick<PrintSessionOptions, "continue" | "resume">): void {
  if (!options.continue && !options.resume) return;
  console.error(
    "`--continue` / `--resume` for project-level print snapshots are not migrated to the daemon store yet.\n" +
      "Omit these flags for a new daemon session, or use TUI `/sessions` / `/resume`.\n" +
      "Example: ohs -p \"follow up\"",
  );
  process.exit(1);
  return;
}

function runTerminalStatus(
  state: OpenHarnessClientState,
  sessionId: string,
  runId: string | undefined,
): "active" | "completed" | "failed" | "unknown" {
  if (!runId) {
    return hasActiveRun(state, sessionId) ? "active" : "unknown";
  }
  const run = state.buckets[sessionId]?.runs[runId];
  if (!run) return hasActiveRun(state, sessionId) ? "active" : "unknown";
  if (run.status === "pending" || run.status === "running") return "active";
  if (run.status === "failed") return "failed";
  return "completed";
}

async function autoReplyPermissions(
  client: OpenHarnessClient,
  state: OpenHarnessClientState,
  sessionId: string,
  approve: boolean,
  seen: Set<string>,
): Promise<void> {
  const bucket = state.buckets[sessionId];
  if (!bucket) return;
  for (const request of Object.values(bucket.permissions)) {
    if (request.status !== "pending" || seen.has(request.id)) continue;
    seen.add(request.id);
    const status = approve ? "approved" : "denied";
    await client.replyPermission(request.id, { status, decision: "once" });
    process.stderr.write(
      approve
        ? `[print] auto-approved permission for ${request.toolName}\n`
        : `[print] auto-denied permission for ${request.toolName}\n`,
    );
  }
}

function renderSessionEvent(
  event: SessionEventRecord | undefined,
  renderer: EventRenderer,
  outputFormat: string | undefined,
  partTextSeen: Map<string, string>,
): void {
  if (!event) return;

  if (outputFormat === "json" || outputFormat === "stream-json") {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }

  if (event.type === "session.message.part.delta") {
    const partId = typeof event.payload.partId === "string" ? event.payload.partId : undefined;
    const delta = typeof event.payload.delta === "string" ? event.payload.delta : undefined;
    const field = event.payload.field;
    if (partId && field === "text" && delta) {
      const previous = partTextSeen.get(partId) ?? "";
      partTextSeen.set(partId, previous + delta);
      void renderer.render({ type: "text_delta", delta });
    }
    return;
  }

  if (event.type === "session.message.part.updated") {
    const part = event.payload.part as SessionMessagePartRecord | undefined;
    if (!part) return;
    if (part.type === "text" && part.text) {
      const previous = partTextSeen.get(part.id) ?? "";
      if (part.text.startsWith(previous) && part.text.length > previous.length) {
        const delta = part.text.slice(previous.length);
        partTextSeen.set(part.id, part.text);
        void renderer.render({ type: "text_delta", delta });
      } else if (!previous && part.status === "completed") {
        partTextSeen.set(part.id, part.text);
        void renderer.render({ type: "text_delta", delta: part.text });
      }
      return;
    }
    if (part.type === "tool" && part.toolName) {
      if (part.status === "running" || (part.input && part.output === undefined)) {
        void renderer.render({
          type: "tool_use_start",
          toolUse: {
            type: "tool_use",
            id: part.toolUseId ?? part.id,
            name: part.toolName,
            input: part.input ?? {},
          },
        });
      }
      if (part.output !== undefined || part.status === "completed" || part.status === "failed") {
        const content = Array.isArray((part.output as { content?: unknown } | undefined)?.content)
          ? (part.output as { content: Array<{ type: string; text?: string }> }).content
          : [{ type: "text", text: part.output == null ? "" : String(part.output) }];
        void renderer.render({
          type: "tool_use_end",
          toolUseId: part.toolUseId ?? part.id,
          result: { content: content as never, isError: part.isError === true },
        });
      }
    }
  }
}

/**
 * Headless print via daemon Session API (opencode-run style).
 */
export async function runPrintSession(
  settings: Settings,
  prompt: string,
  options: PrintSessionOptions,
): Promise<void> {
  rejectPrintContinueResume(options);

  const daemon = await ensureLocalDaemon();
  const client = new OpenHarnessClient({
    baseUrl: daemon.url,
    token: daemon.token,
  });

  const cwd = options.cwd ? options.cwd : process.cwd();
  const model = options.model ?? settings.model;
  const session = await client.createSession({
    cwd,
    model,
    title: "print",
    metadata: buildPrintSessionMetadata(settings, options),
  });

  const controller = new AbortController();
  const renderer = new EventRenderer({
    verbose: options.verbose,
    printMode: true,
    outputStyle: settings.outputStyle,
  });
  const partTextSeen = new Map<string, string>();
  const permissionSeen = new Set<string>();
  const approvePermissions = options.dangerouslySkipPermissions === true;

  let admitted = false;
  let runId: string | undefined;
  let exitCode = 0;

  const syncLoop = (async () => {
    for await (const update of syncEvents(client, {
      sessionId: session.id,
      signal: controller.signal,
    })) {
      if (update.source === "snapshot" && !admitted) {
        admitted = true;
        const response = await client.admitPrompt(session.id, { id: createPromptRequestId(), content: prompt });
        runId = response.run?.id;
      }

      await autoReplyPermissions(
        client,
        update.state,
        session.id,
        approvePermissions,
        permissionSeen,
      );

      if (update.source === "live") {
        renderSessionEvent(update.event, renderer, options.outputFormat, partTextSeen);
      }

      if (!admitted) continue;
      const terminal = runTerminalStatus(update.state, session.id, runId);
      if (terminal === "active" || terminal === "unknown") continue;
      if (terminal === "failed") exitCode = 1;
      controller.abort();
      break;
    }
  })();

  try {
    await syncLoop;
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exit(1);
      return;
    }
  }

  if (!options.outputFormat || options.outputFormat === "text") {
    process.stdout.write("\n");
  }

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
