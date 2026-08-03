import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  OpenHarnessClient,
  createPromptRequestId,
  createInitialClientState,
  selectSessionMessagesWithParts,
  syncEvents,
  type CommandCatalogEntry,
  type OpenHarnessClientState,
  type PermissionRequestRecord,
  type SessionBucket,
  type SessionMessagePartRecord,
  type SessionMessageRecord,
} from "@openharness/client";

import type { FrontendConfig, TranscriptItem } from "../types";
import type { TuiSessionController } from "./sessionController";
import {
  dispatchSessionSlashCommand,
  hasActiveRun,
  mergeCommandDetails,
  parseSlashLine,
} from "./sessionSlashCommands";

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === "object" && "text" in block) return String(block.text ?? "");
        return JSON.stringify(block);
      })
      .join("");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

type OrderedTranscriptItem = TranscriptItem & { order: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sessionRuntimeMetadata(input: {
  permissionMode?: unknown;
  maxTurns?: unknown;
}): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (typeof input.permissionMode === "string" && input.permissionMode) {
    metadata.permissionMode = input.permissionMode;
  }
  if (typeof input.maxTurns === "number" && Number.isFinite(input.maxTurns)) {
    metadata.maxTurns = input.maxTurns;
  }
  return metadata;
}

function textFromParts(parts: SessionMessagePartRecord[]): string {
  return parts
    .filter((part) => part.type === "text" || part.type === "reasoning")
    .map((part) => part.text ?? "")
    .join("");
}

function messageToTranscriptItems(
  message: SessionMessageRecord,
  parts: SessionMessagePartRecord[],
): TranscriptItem[] {
  if (message.role === "user") return [{ id: message.id, role: "user", text: textFromParts(parts) }];
  if (message.role === "system") return [{ id: message.id, role: "system", text: textFromParts(parts) }];

  const items: TranscriptItem[] = [];
  for (const part of parts) {
    if (part.type === "text" || part.type === "reasoning") {
      if (part.text) items.push({
        id: `${message.id}:${part.id}`,
        role: "assistant",
        text: part.text,
        streaming: part.status === "pending" || part.status === "running",
      });
      continue;
    }
    if (part.type === "tool") {
      const toolName = part.toolName ?? "tool";
      items.push({
        id: `${message.id}:${part.id}:tool`,
        role: "tool",
        text: toolName,
        tool_name: toolName,
        tool_input: part.input,
      });
      if (part.output !== undefined) {
        const output = isRecord(part.output) ? part.output : {};
        items.push({
          id: `${message.id}:${part.id}:result`,
          role: "tool_result",
          text: contentToText(output.content),
          tool_name: toolName,
          is_error: part.isError === true,
        });
      }
      continue;
    }
    if (part.type === "tool_result") {
      items.push({
        id: `${message.id}:${part.id}:result`,
        role: "tool_result",
        text: contentToText(part.output ?? part.text ?? ""),
        tool_name: part.toolName,
        is_error: part.isError === true,
      });
      continue;
    }
    if (part.type === "error") {
      items.push({ id: `${message.id}:${part.id}`, role: "system", text: part.text ?? "error" });
      continue;
    }
    if (part.type === "log") {
      items.push({ id: `${message.id}:${part.id}`, role: "log", text: part.text ?? "" });
    }
  }
  return items;
}

function bucketToTranscript(bucket: SessionBucket | undefined): TranscriptItem[] {
  if (!bucket) return [];
  const rows: OrderedTranscriptItem[] = [];
  for (const { message, parts } of selectSessionMessagesWithParts(bucket)) {
    const items = messageToTranscriptItems(message, parts);
    items.forEach((item, index) => {
      rows.push({ ...item, order: message.seq * 100 + index });
    });
  }
  const userMessageTexts = new Set(
    rows.filter((item) => item.role === "user").map((item) => item.text),
  );
  for (const input of bucket.inputs
    .filter((input) => !userMessageTexts.has(input.content))
  ) {
    rows.push({ role: "user", text: input.content, order: input.seq * 100 - 1 });
  }
  return rows
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...item }) => item);
}

function permissionToModal(request: PermissionRequestRecord): Record<string, unknown> {
  const input = request.payload.input && typeof request.payload.input === "object"
    ? request.payload.input as Record<string, unknown>
    : {};
  return {
    kind: "permission",
    request_id: request.id,
    tool_name: request.toolName,
    reason: typeof request.payload.reason === "string" ? request.payload.reason : null,
    input,
  };
}

function firstPendingPermission(state: OpenHarnessClientState, sessionId?: string): PermissionRequestRecord | undefined {
  if (!sessionId) return undefined;
  const bucket = state.buckets[sessionId];
  if (!bucket) return undefined;
  return Object.values(bucket.permissions)
    .filter((request) => request.status === "pending")
    .sort((a, b) => a.createdAt - b.createdAt)
    .at(0);
}

export function useServerSync(
  config: FrontendConfig,
  onError?: (message: string) => void,
): TuiSessionController {
  const daemon = config.daemon;
  const [clientState, setClientState] = useState<OpenHarnessClientState>(() => createInitialClientState());
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>();
  const [status, setStatus] = useState<Record<string, unknown>>({
    permission_mode: daemon?.permissionMode ?? "default",
    model: daemon?.model ?? "default",
    ...(typeof daemon?.maxTurns === "number" ? { max_turns: daemon.maxTurns } : {}),
  });
  const [modal, setModal] = useState<Record<string, unknown> | null>(null);
  const [selectRequest, setSelectRequest] = useState<TuiSessionController["selectRequest"]>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const [submittedRun, setSubmittedRun] = useState<{ sessionId: string; runId: string } | null>(null);
  const [ready, setReady] = useState(false);
  const [systemItems, setSystemItems] = useState<TranscriptItem[]>([]);
  const [commandCatalog, setCommandCatalog] = useState<CommandCatalogEntry[]>([]);
  const clientRef = useRef<OpenHarnessClient | null>(null);
  const activeSessionIdRef = useRef<string | undefined>(undefined);
  const commandCatalogRef = useRef<CommandCatalogEntry[]>([]);
  const statusRef = useRef(status);
  const sentInitialPromptRef = useRef(false);
  const shownPermissionIdRef = useRef<string | undefined>(undefined);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    commandCatalogRef.current = commandCatalog;
  }, [commandCatalog]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const reportError = useCallback((message: string) => {
    setSystemItems((items) => [...items, { role: "system", text: `error: ${message}` }]);
    onErrorRef.current?.(message);
    setLocalBusy(false);
    setSubmittedRun(null);
  }, []);

  const pushSystem = useCallback((text: string) => {
    setSystemItems((items) => [...items, { role: "system", text }]);
  }, []);

  useEffect(() => {
    if (!daemon?.url) {
      setReady(true);
      reportError("Daemon URL is required for TUI. Launch with `ohs` or `ohs --tui` so the CLI can start or attach the daemon.");
      return;
    }
    let cancelled = false;
    const client = new OpenHarnessClient({ baseUrl: daemon.url, token: daemon.token ?? undefined });
    clientRef.current = client;

    void (async () => {
      try {
        await client.health();
        const cwd = daemon.cwd ?? process.cwd();
        const model = daemon.model ?? "default";
        const [sessions, commands] = await Promise.all([
          client.listSessions({ cwd, limit: 20 }),
          client.listCommands({ cwd }).catch(() => [] as CommandCatalogEntry[]),
        ]);
        const metadata = sessionRuntimeMetadata({
          permissionMode: daemon?.permissionMode ?? "default",
          maxTurns: daemon?.maxTurns,
        });
        const session = sessions[0] ?? await client.createSession({
          cwd,
          model,
          title: "TUI",
          metadata,
        });
        if (cancelled) return;
        setCommandCatalog(commands);
        setStatus((current) => ({
          ...current,
          model: session.model,
          session_id: session.id,
          cwd: session.cwd,
          permission_mode:
            typeof session.metadata.permissionMode === "string"
              ? session.metadata.permissionMode
              : current.permission_mode,
          ...(typeof session.metadata.maxTurns === "number"
            ? { max_turns: session.metadata.maxTurns }
            : {}),
        }));
        setActiveSessionId(session.id);
        void client.getSession(session.id).catch(() => {});
        setReady(true);
      } catch (error) {
        if (cancelled) return;
        setReady(true);
        reportError(error instanceof Error ? error.message : String(error));
      }
    })();

    return () => {
      cancelled = true;
      clientRef.current = null;
    };
  }, [daemon?.cwd, daemon?.model, daemon?.token, daemon?.url, reportError]);

  useEffect(() => {
    const client = clientRef.current;
    if (!client || !activeSessionId) return;
    const controller = new AbortController();

    void (async () => {
      let reconnectNotice = false;
      try {
        for await (const update of syncEvents(client, {
          sessionId: activeSessionId,
          signal: controller.signal,
        })) {
          if (update.source === "reconnecting") {
            if (!reconnectNotice) {
              reconnectNotice = true;
              setSystemItems((items) => [...items, { role: "system", text: "reconnecting…" }]);
            }
            continue;
          }
          if (reconnectNotice) reconnectNotice = false;
          setClientState(update.state);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        reportError(error instanceof Error ? error.message : String(error));
      }
    })();

    return () => {
      controller.abort();
    };
  }, [activeSessionId, reportError]);

  useEffect(() => {
    if (!activeSessionId || !ready || sentInitialPromptRef.current || !config.initial_prompt) return;
    sentInitialPromptRef.current = true;
    const client = clientRef.current;
    if (!client) return;
    setLocalBusy(true);
    void client.admitPrompt(activeSessionId, { id: createPromptRequestId(), content: config.initial_prompt })
      .then((response) => {
        setLocalBusy(false);
        setSubmittedRun(response.run ? { sessionId: activeSessionId, runId: response.run.id } : null);
      })
      .catch((error) => reportError(error instanceof Error ? error.message : String(error)));
  }, [activeSessionId, config.initial_prompt, ready, reportError]);

  useEffect(() => {
    const pending = firstPendingPermission(clientState, activeSessionId);
    if (!pending) {
      shownPermissionIdRef.current = undefined;
      if (modal?.kind === "permission") setModal(null);
      return;
    }
    if (shownPermissionIdRef.current === pending.id) return;
    shownPermissionIdRef.current = pending.id;
    setModal(permissionToModal(pending));
  }, [activeSessionId, clientState, modal?.kind]);

  const running = hasActiveRun(clientState, activeSessionId);
  useEffect(() => {
    if (!submittedRun) return;
    const run = clientState.buckets[submittedRun.sessionId]?.runs[submittedRun.runId];
    if (run && run.status !== "pending" && run.status !== "running") setSubmittedRun(null);
  }, [clientState, submittedRun]);

  const createAndSwitchSession = useCallback(async (title?: string): Promise<void> => {
    const client = clientRef.current;
    if (!client) return;
    const cwd = daemon?.cwd ?? process.cwd();
    const model = daemon?.model ?? "default";
    const metadata = sessionRuntimeMetadata({
      permissionMode: statusRef.current.permission_mode ?? daemon?.permissionMode ?? "default",
      maxTurns: statusRef.current.max_turns ?? daemon?.maxTurns,
    });
    const session = await client.createSession({
      cwd,
      model,
      title: title?.trim() || "TUI",
      metadata,
    });
    setActiveSessionId(session.id);
    setStatus((current) => ({
      ...current,
      model: session.model,
      session_id: session.id,
      cwd: session.cwd,
      permission_mode:
        typeof session.metadata.permissionMode === "string"
          ? session.metadata.permissionMode
          : current.permission_mode,
      ...(typeof session.metadata.maxTurns === "number"
        ? { max_turns: session.metadata.maxTurns }
        : {}),
    }));
    setSelectRequest(null);
    setLocalBusy(false);
    setSubmittedRun(null);
  }, [daemon?.cwd, daemon?.maxTurns, daemon?.model, daemon?.permissionMode]);

  const sendRequest = useCallback((payload: Record<string, unknown>): void => {
    const client = clientRef.current;
    if (!client) return;
    const sessionId = activeSessionIdRef.current;

    void (async () => {
      const type = String(payload.type ?? "");
      if (type === "submit_line") {
        const line = String(payload.line ?? "");
        const slash = parseSlashLine(line);

        const newSession = line.match(/^\/new(?:\s+(.+))?$/);
        if (newSession) {
          setLocalBusy(false);
          setSubmittedRun(null);
          await createAndSwitchSession(newSession[1]);
          return;
        }
        const resume = line.match(/^\/resume\s+(.+)$/);
        if (resume?.[1]) {
          const target = resume[1].trim();
          const session = await client.getSession(target);
          setLocalBusy(false);
          setSubmittedRun(null);
          setActiveSessionId(target);
          setStatus((current) => ({
            ...current,
            model: session.model,
            session_id: session.id,
            cwd: session.cwd,
          }));
          setSelectRequest(null);
          return;
        }

        const slashResult = await dispatchSessionSlashCommand(slash, {
          client,
          sessionId,
          pushSystem,
          statusRef,
          commandCatalogRef,
          clientState,
          localBusy,
          daemon,
          setStatus,
        });
        if (slashResult === "handled" || slashResult === "local_ui_ignored") return;

        if (slash) {
          const catalogEntry = commandCatalogRef.current.find((entry) => entry.name === slash.name);
          if (catalogEntry?.kind === "template") {
            if (!sessionId) return;
            setLocalBusy(true);
            const response = await client.invokeCommand(sessionId, {
              name: slash.name,
              args: slash.args,
            });
            setLocalBusy(false);
            setSubmittedRun(response.run ? { sessionId, runId: response.run.id } : null);
            return;
          }
          pushSystem(`Unknown command: ${slash.name}`);
          return;
        }

        if (!sessionId) return;
        setLocalBusy(true);
        const response = await client.admitPrompt(sessionId, { id: createPromptRequestId(), content: line });
        setLocalBusy(false);
        setSubmittedRun(response.run ? { sessionId, runId: response.run.id } : null);
        return;
      }

      if (type === "delete_session") {
        const target = typeof payload.session_id === "string" ? payload.session_id : undefined;
        if (!target) return;
        await client.archiveSession(target);
        setLocalBusy(false);
        setSubmittedRun(null);
        setSelectRequest((current) => current
          ? { ...current, options: current.options.filter((option) => option.value !== target) }
          : current);
        if (target === activeSessionIdRef.current) {
          const sessions = await client.listSessions({
            cwd: daemon?.cwd ?? undefined,
            includeArchived: false,
            limit: 20,
          });
          const next = sessions.find((session) => session.id !== target);
          if (next) {
            setActiveSessionId(next.id);
            setStatus((current) => ({
              ...current,
              model: next.model,
              session_id: next.id,
              cwd: next.cwd,
            }));
          } else {
            await createAndSwitchSession();
          }
        }
        return;
      }

      if (type === "interrupt") {
        if (sessionId) await client.interruptSession(sessionId);
        setLocalBusy(false);
        setSubmittedRun(null);
        return;
      }

      if (type === "permission_response") {
        const requestId = typeof payload.request_id === "string" ? payload.request_id : undefined;
        if (!requestId) return;
        const allowed = payload.allowed === true;
        await client.replyPermission(requestId, {
          status: allowed ? "approved" : "denied",
          decision: payload.scope === "session" ? "session" : "once",
          clientId: "tui",
        });
        setModal(null);
        return;
      }

      if (type === "list_sessions") {
        const sessions = await client.listSessions({
          cwd: daemon?.cwd ?? undefined,
          includeArchived: false,
          limit: 20,
        });
        setSelectRequest({
          title: "Sessions",
          submitPrefix: "/resume ",
          options: sessions.map((session) => ({
            value: session.id,
            label: `${session.id === activeSessionId ? "* " : ""}${session.title || session.id}`,
            description: `${session.model} | ${session.status}`,
          })),
        });
        return;
      }

      if (type === "set_permission_mode") {
        const mode = String(payload.permission_mode ?? "default");
        setStatus((current) => ({ ...current, permission_mode: mode }));
        if (sessionId) {
          const current = await client.getSession(sessionId);
          await client.updateSession(sessionId, {
            metadata: { ...current.metadata, permissionMode: mode },
          });
        }
        return;
      }

    })().catch((error) => {
      reportError(error instanceof Error ? error.message : String(error));
    });
  }, [activeSessionId, clientState, createAndSwitchSession, daemon?.cwd, daemon?.model, localBusy, pushSystem, reportError]);

  const bucket = activeSessionId ? clientState.buckets[activeSessionId] : undefined;
  const transcript = useMemo(
    () => [...bucketToTranscript(bucket), ...systemItems],
    [bucket, systemItems],
  );
  const submittedRunRecord = submittedRun
    ? clientState.buckets[submittedRun.sessionId]?.runs[submittedRun.runId]
    : undefined;
  const waitingForSubmittedRun = !!submittedRun && (
    !submittedRunRecord || submittedRunRecord.status === "pending" || submittedRunRecord.status === "running"
  );
  const commandDetails = useMemo(() => mergeCommandDetails(commandCatalog), [commandCatalog]);
  const commands = useMemo(() => commandDetails.map((entry) => entry.name), [commandDetails]);

  return useMemo(
    () => ({
      transcript,
      assistantBuffer: "",
      status,
      tasks: [],
      commands,
      commandDetails,
      mcpServers: [],
      bridgeSessions: [],
      modal,
      selectRequest,
      busy: localBusy || running || waitingForSubmittedRun,
      ready,
      todoMarkdown: "",
      swarmTeammates: [],
      swarmNotifications: [],
      workflowState: null,
      setModal,
      setSelectRequest,
      setBusy: setLocalBusy,
      sendRequest,
    }),
    [commandDetails, commands, localBusy, modal, ready, running, selectRequest, sendRequest, status, transcript, waitingForSubmittedRun],
  );
}
