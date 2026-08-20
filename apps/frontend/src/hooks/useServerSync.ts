import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import {
  OpenHarnessClient,
  createPromptRequestId,
  createInitialClientState,
  patchSessionRuntimeMetadata,
  readSessionRuntimeConfig,
  syncEvents,
  type CommandCatalogEntry,
  type JobReadResult,
  type JobSnapshot,
  type McpServerStatus,
  type ModelProviderInfo,
  type OpenHarnessClientState,
  type PermissionRequestRecord,
  type PresentationReadRequest,
  type SessionRuntimeConfigPatch,
  type SessionBucket,
  type SessionRecord,
  type SyncEventUpdate,
  type TaskSnapshot,
} from "@openharness/client";

import type { FrontendConfig, McpServerSnapshot, TranscriptItem, WorkflowTuiState } from "../types";
import type { TuiAction, TuiSessionController } from "./sessionController";
import { bucketToTranscript, splitStreamingAssistant } from "./transcript";
import {
  dispatchSessionSlashCommand,
  hasActiveRun,
  mergeCommandDetails,
  parseSlashLine
} from "./sessionSlashCommands";

type DisplayRequest = NonNullable<TuiSessionController["displayRequest"]>;
type PresentationCacheEntry = {
  title: string;
  content: string;
  updatedAt: number;
};

const LIVE_TEXT_DELTA_FLUSH_MS = 33;
const PRESENTATION_LOADING_TEXT = "Loading...";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sessionRuntimeMetadata(input: {
  model?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
  apiFormat?: unknown;
  permissionMode?: unknown;
  maxTurns?: unknown;
  sessionMode?: unknown
}): Record<string, unknown> {
  const runtime: SessionRuntimeConfigPatch = {};
  if (typeof input.model === "string" && input.model) {
    runtime.model = input.model;
  }
  if (typeof input.provider === "string" && input.provider) {
    runtime.provider = input.provider;
  }
  if (typeof input.baseUrl === "string" && input.baseUrl) {
    runtime.baseUrl = input.baseUrl;
  }
  if (input.apiFormat === "anthropic" || input.apiFormat === "openai") {
    runtime.apiFormat = input.apiFormat;
  }
  if (input.permissionMode === "default" || input.permissionMode === "plan" || input.permissionMode === "full_auto") {
    runtime.permissionMode = input.permissionMode;
  }
  if (typeof input.maxTurns === "number" && Number.isFinite(input.maxTurns)) {
    runtime.maxTurns = input.maxTurns;
  }
  if (input.sessionMode === "coordinator" || input.sessionMode === "direct") {
    runtime.sessionMode = input.sessionMode;
  }
  return patchSessionRuntimeMetadata({}, runtime);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function mcpServerSnapshot(server: McpServerStatus): McpServerSnapshot {
  return {
    name: server.name,
    state: server.status,
    ...(server.error || server.command ? { detail: server.error ?? server.command } : {}),
    tool_count: server.toolCount,
    resource_count: server.resourceCount,
  };
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function workflowStateFromJobs(input: { jobs: JobSnapshot[]; selectedRunId?: string; details?: JobReadResult; filters?: WorkflowTuiState["filters"]; notice?: string; error?: string }): WorkflowTuiState {
  const selectedRunId = input.selectedRunId && input.jobs.some((job) => job.id === input.selectedRunId) ? input.selectedRunId : input.jobs[0]?.id;
  const details = input.details?.details ?? {};
  const plan = isRecord(details.plan) ? details.plan : {};
  const results = isRecord(details.results) ? details.results : {};
  const blockedTasks = isRecord(details.blockedTasks) ? details.blockedTasks : {};
  const runningTasks = isRecord(details.runningTasks) ? details.runningTasks : {};
  const pendingTaskIds = new Set(stringValues(details.pendingTaskIds));
  const runningTaskIds = new Set(stringValues(details.runningTaskIds));
  const blockedTaskIds = new Set(stringValues(details.blockedTaskIds));
  const taskRecords = Array.isArray(plan.tasks) ? plan.tasks.filter(isRecord) : [];
  const allTasks = taskRecords.map((task) => {
    const taskId = stringValue(task.id) ?? "unknown";
    const result = isRecord(results[taskId]) ? results[taskId] : undefined;
    const running = isRecord(runningTasks[taskId]) ? runningTasks[taskId] : undefined;
    const blocked = isRecord(blockedTasks[taskId]) ? blockedTasks[taskId] : undefined;
    const status = stringValue(result?.status) ?? (blockedTaskIds.has(taskId) || blocked ? "blocked" : undefined) ?? (runningTaskIds.has(taskId) || running ? "running" : undefined) ?? (pendingTaskIds.has(taskId) ? "pending" : "pending");
    return {
      taskId,
      status,
      summary: stringValue(result?.summary) ?? stringValue(running?.summary) ?? stringValue(blocked?.reason) ?? stringValue(task.description),
      dependencies: stringValues(task.dependsOn),
      taskManagerTaskId: stringValue(task.taskManagerTaskId),
    };
  });
  const filters = input.filters ?? {};
  const tasks = allTasks.filter((task) => (!filters.taskId || task.taskId === filters.taskId) && (!filters.status || task.status === filters.status));
  const selectedJob = input.jobs.find((job) => job.id === selectedRunId);
  const reconciliationPlan = isRecord(details.reconciliationPlan) ? details.reconciliationPlan : {};
  const reconciliationActions = Array.isArray(reconciliationPlan.actions)
    ? reconciliationPlan.actions.filter(isRecord).flatMap((action) => {
        const actionId = stringValue(action.actionId);
        const taskId = stringValue(action.taskId);
        if (!actionId || !taskId) return [];
        return [
          {
            actionId,
            issueIds: stringValues(action.issueIds),
            taskId,
            description: stringValue(action.description) ?? actionId,
            prompt: stringValue(action.prompt) ?? "",
            writeScope: stringValues(action.writeScope),
            dependsOn: stringValues(action.dependsOn),
          },
        ];
      })
    : [];
  const needed = details.needsReconciliation === true || reconciliationActions.length > 0;
  const statuses = [...new Set([...input.jobs.map((job) => job.status), ...tasks.map((task) => task.status)])];
  return {
    runs: input.jobs.map((job) => {
      const metadata = job.metadata ?? {};
      const totalTasks = numberValue(metadata.totalTasks) ?? tasks.length;
      return {
        runId: job.id,
        status: job.status,
        summary: job.label || job.detail || job.id,
        mode: stringValue(metadata.mode) ?? stringValue(plan.mode) ?? "workflow",
        totalTasks,
        completedTasks: numberValue(metadata.completedTasks) ?? allTasks.filter((task) => task.status === "completed").length,
        failedTasks: numberValue(metadata.failedTasks) ?? allTasks.filter((task) => task.status === "failed").length,
        pendingTasks: numberValue(metadata.pendingTasks) ?? allTasks.filter((task) => task.status === "pending").length,
        runningTasks: numberValue(metadata.runningTasks) ?? allTasks.filter((task) => task.status === "running").length,
        blockedTasks: numberValue(metadata.blockedTasks) ?? allTasks.filter((task) => task.status === "blocked").length,
        needsReconciliation: job.id === selectedRunId ? needed : false,
        budgetPolicyPreset: stringValue(metadata.budgetPolicyPreset),
        createdAt: job.startedAt,
        updatedAt: job.updatedAt,
      };
    }),
    selectedRunId,
    snapshot: input.details?.details ?? (selectedJob ? { ...selectedJob } : undefined),
    tasks,
    timeline: [],
    filters,
    available: {
      taskIds: allTasks.map((task) => task.taskId),
      statuses,
    },
    ...(needed
      ? {
          reconciliation: {
            needed,
            summary: stringValue(reconciliationPlan.summary) ?? "Workflow reconciliation is required.",
            actions: reconciliationActions,
          },
        }
      : {}),
    notice: input.notice,
    error: input.error,
  };
}

function normalizeSessionMode(value: unknown): "coordinator" | null {
  return value === "coordinator" ? "coordinator" : null;
}

function statusSessionMode(value: unknown): "coordinator" | "direct" {
  return normalizeSessionMode(value) ?? "direct";
}

function stringSetting(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

type RecoverableRun = {
  id: string;
  error?: string;
  prompt: string;
};

function archiveClientSession(
  state: OpenHarnessClientState,
  sessionId: string,
  archivedAt: number
): OpenHarnessClientState {
  const current = state.sessions[sessionId];
  if (!current || current.status === "archived") return state;
  const archived: SessionRecord = {
    ...current,
    status: "archived",
    archivedAt,
    updatedAt: Math.max(current.updatedAt, archivedAt),
  };
  const bucket = state.buckets[sessionId];
  return {
    ...state,
    sessions: { ...state.sessions, [sessionId]: archived },
    buckets: bucket
      ? { ...state.buckets, [sessionId]: { ...bucket, session: archived } }
      : state.buckets,
  };
}

function listTopLevelSessions(
  sessions: Iterable<SessionRecord>,
  activeSessionId?: string
): SessionRecord[] {
  return [...sessions]
    .filter((session) => !session.parentId && session.status !== "archived")
    .sort((a, b) => {
      if (a.id === activeSessionId) return -1;
      if (b.id === activeSessionId) return 1;
      return b.updatedAt - a.updatedAt;
    });
}

function sessionSelectOptions(
  sessions: Iterable<SessionRecord>,
  activeSessionId?: string
): NonNullable<TuiSessionController["selectRequest"]>["options"] {
  return listTopLevelSessions(sessions, activeSessionId).map((session) => ({
    value: session.id,
    label: `${session.id === activeSessionId ? "* " : ""}${session.title || session.id}`,
    description: `${session.model} | ${session.status}`,
  }));
}

function shouldAutoActivateSession(session: SessionRecord, defaultModel: string): boolean {
  return readSessionRuntimeConfig(session).model === defaultModel;
}

function recoverableInterruptedRuns(bucket?: SessionBucket): RecoverableRun[] {
  if (!bucket) return [];
  const recoveredSourceRunIds = new Set(bucket.inputs.flatMap((input) => (isRecord(input.metadata.recovery) && typeof input.metadata.recovery.sourceRunId === "string" ? [input.metadata.recovery.sourceRunId] : [])));
  return Object.values(bucket.runs)
    .filter((run) => run.status === "interrupted" && !!run.inputId && !recoveredSourceRunIds.has(run.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .flatMap((run) => {
      const input = bucket.inputs.find((candidate) => candidate.id === run.inputId);
      return input ? [{ id: run.id, error: run.error, prompt: input.content }] : [];
    });
}

function shouldCoalesceClientState(update: SyncEventUpdate): boolean {
  return update.source === "live" && update.event?.type === "session.message.part.delta";
}

function permissionToModal(request: PermissionRequestRecord): Record<string, unknown> {
  const input = request.payload.input && typeof request.payload.input === "object" ? (request.payload.input as Record<string, unknown>) : {};
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

export function useServerSync(config: FrontendConfig, onError?: (message: string) => void): TuiSessionController {
  const daemon = config.daemon;
  const [clientState, setClientState] = useState<OpenHarnessClientState>(() => createInitialClientState());
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>();
  const [status, setStatus] = useState<Record<string, unknown>>({
    permission_mode: daemon?.permissionMode ?? "default",
    model: daemon?.model ?? "default",
    session_mode: statusSessionMode(daemon?.sessionMode),
    ...(typeof daemon?.maxTurns === "number" ? { max_turns: daemon.maxTurns } : {}),
  });
  const [modal, setModal] = useState<Record<string, unknown> | null>(null);
  const [selectRequest, setSelectRequest] = useState<TuiSessionController["selectRequest"]>(null);
  const [displayRequest, setDisplayRequest] = useState<TuiSessionController["displayRequest"]>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const [submittedRun, setSubmittedRun] = useState<{
    sessionId: string;
    runId: string;
  } | null>(null);
  const [ready, setReady] = useState(false);
  const [globalSystemItems, setGlobalSystemItems] = useState<TranscriptItem[]>([]);
  const [systemItemsBySession, setSystemItemsBySession] = useState<Record<string, TranscriptItem[]>>({});
  const [commandCatalog, setCommandCatalog] = useState<CommandCatalogEntry[]>([]);
  const [workflowState, setWorkflowState] = useState<WorkflowTuiState | null>(null);
  const [tasks, setTasks] = useState<TaskSnapshot[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerSnapshot[]>([]);
  const clientRef = useRef<OpenHarnessClient | null>(null);
  const activeSessionIdRef = useRef<string | undefined>(undefined);
  const commandCatalogRef = useRef<CommandCatalogEntry[]>([]);
  const defaultRuntimeRef = useRef<{
    model: string;
    provider?: string;
    baseUrl?: string;
    apiFormat?: "anthropic" | "openai";
  }>({
    model: daemon?.model ?? "default",
  });
  const nextSessionModeRef = useRef<"coordinator" | "direct">(statusSessionMode(daemon?.sessionMode));
  const statusRef = useRef(status);
  const sentInitialPromptRef = useRef(false);
  const pendingNewSessionTitleRef = useRef<string | undefined>(undefined);
  const listedSessionsRef = useRef<Record<string, SessionRecord>>({});
  const presentationCacheRef = useRef<Record<string, PresentationCacheEntry>>({});
  const displayRequestRef = useRef<TuiSessionController["displayRequest"]>(null);
  const pendingClientStateRef = useRef<OpenHarnessClientState | null>(null);
  const pendingClientStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shownPermissionIdRef = useRef<string | undefined>(undefined);
  const workflowStateRef = useRef<WorkflowTuiState | null>(null);
  const workflowGenerationRef = useRef(0);
  const auxiliaryGenerationRef = useRef(0);
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

  useEffect(() => {
    displayRequestRef.current = displayRequest;
  }, [displayRequest]);

  const clearDisplayRequest = useCallback(() => {
    displayRequestRef.current = null;
    setDisplayRequest(null);
  }, []);

  const showDisplayRequest = useCallback((request: DisplayRequest) => {
    displayRequestRef.current = request;
    setSelectRequest(null);
    setDisplayRequest(request);
  }, []);

  const setWorkflowStateCurrent = useCallback((state: WorkflowTuiState | null): void => {
    workflowStateRef.current = state;
    setWorkflowState(state);
  }, []);

  const invalidateWorkflowRequests = useCallback((): void => {
    workflowGenerationRef.current += 1;
  }, []);

  const clearAuxiliaryState = useCallback((): void => {
    auxiliaryGenerationRef.current += 1;
    setTasks([]);
    setMcpServers([]);
  }, []);

  const setStatusAndDefault = useCallback((value: SetStateAction<Record<string, unknown>>) => {
    setStatus((current) => {
      const next = typeof value === "function" ? value(current) : value;
      if (typeof next.model === "string" && !activeSessionIdRef.current) {
        defaultRuntimeRef.current = {
          ...defaultRuntimeRef.current,
          model: next.model,
          ...(typeof next.provider === "string" ? { provider: next.provider } : {}),
          ...(typeof next.baseUrl === "string" ? { baseUrl: next.baseUrl } : {}),
          ...(next.apiFormat === "anthropic" || next.apiFormat === "openai" ? { apiFormat: next.apiFormat } : {}),
        };
      }
      return next;
    });
  }, []);

  const pushSystem = useCallback((text: string) => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      setGlobalSystemItems((items) => [...items, { role: "system", text }]);
      return;
    }
    setSystemItemsBySession((itemsBySession) => ({
      ...itemsBySession,
      [sessionId]: [...(itemsBySession[sessionId] ?? []), { role: "system", text }],
    }));
  }, []);

  const reportError = useCallback(
    (message: string) => {
    pushSystem(`error: ${message}`);
    onErrorRef.current?.(message);
    setLocalBusy(false);
    setSubmittedRun(null);
    },
    [pushSystem],
  );

  const loadModels = useCallback(async (): Promise<ModelProviderInfo[]> => {
    const client = clientRef.current;
    if (!client) return [];
    return await client.listModels();
  }, []);

  const cacheFirstRead = useCallback(
    (request: PresentationReadRequest): void => {
    const cached = presentationCacheRef.current[request.key];
    showDisplayRequest({
      key: request.key,
      title: request.title,
      content: cached?.content ?? PRESENTATION_LOADING_TEXT,
    });

      void request
        .load()
      .then((content) => {
        presentationCacheRef.current = {
          ...presentationCacheRef.current,
          [request.key]: {
            title: request.title,
            content,
            updatedAt: Date.now(),
          },
        };
        if (displayRequestRef.current?.key !== request.key) return;
        showDisplayRequest({
          key: request.key,
          title: request.title,
          content,
        });
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
          const content = cached ? `${cached.content}\n\nRefresh failed: ${message}` : `Failed to load ${request.title}: ${message}`;
        if (displayRequestRef.current?.key !== request.key) return;
        showDisplayRequest({
          key: request.key,
          title: request.title,
          content,
        });
      });
    },
    [showDisplayRequest],
  );

  const clearPendingClientState = useCallback(() => {
    if (pendingClientStateTimerRef.current) {
      clearTimeout(pendingClientStateTimerRef.current);
      pendingClientStateTimerRef.current = null;
    }
    pendingClientStateRef.current = null;
  }, []);

  const commitClientState = useCallback(
    (state: OpenHarnessClientState, coalesce: boolean) => {
    if (!coalesce) {
      clearPendingClientState();
      setClientState(state);
      return;
    }

    pendingClientStateRef.current = state;
    if (pendingClientStateTimerRef.current) return;
    pendingClientStateTimerRef.current = setTimeout(() => {
      pendingClientStateTimerRef.current = null;
      const pending = pendingClientStateRef.current;
      pendingClientStateRef.current = null;
      if (pending) setClientState(pending);
    }, LIVE_TEXT_DELTA_FLUSH_MS);
    },
    [clearPendingClientState],
  );

  useEffect(() => clearPendingClientState, [clearPendingClientState]);

  const activateSession = useCallback(
    (session: SessionRecord): void => {
    const runtime = readSessionRuntimeConfig(session, defaultRuntimeRef.current);
    activeSessionIdRef.current = session.id;
    setActiveSessionId(session.id);
      invalidateWorkflowRequests();
      setWorkflowStateCurrent(null);
      clearAuxiliaryState();
    setStatus((current) => ({
      ...current,
      model: runtime.model,
      ...(runtime.provider ? { provider: runtime.provider } : {}),
      session_id: session.id,
      cwd: session.cwd,
        permission_mode: typeof runtime.permissionMode === "string" ? runtime.permissionMode : current.permission_mode,
        ...(typeof runtime.maxTurns === "number" ? { max_turns: runtime.maxTurns } : {}),
      session_mode: statusSessionMode(runtime.sessionMode),
    }));
    },
    [clearAuxiliaryState, invalidateWorkflowRequests, setWorkflowStateCurrent],
  );

  const returnToHome = useCallback(
    (title?: string): void => {
    pendingNewSessionTitleRef.current = title?.trim() || undefined;
    activeSessionIdRef.current = undefined;
    setActiveSessionId(undefined);
      invalidateWorkflowRequests();
    clearAuxiliaryState();
    setLocalBusy(false);
    setSubmittedRun(null);
    setSelectRequest(null);
    clearDisplayRequest();
    setModal(null);
      setWorkflowStateCurrent(null);
    setStatus((current) => {
      const next = { ...current };
      delete next.session_id;
      next.model = defaultRuntimeRef.current.model;
      if (defaultRuntimeRef.current.provider) next.provider = defaultRuntimeRef.current.provider;
      else delete next.provider;
      next.session_mode = nextSessionModeRef.current;
      return next;
    });
    },
    [clearAuxiliaryState, clearDisplayRequest, invalidateWorkflowRequests, setWorkflowStateCurrent],
  );

  useEffect(() => {
    if (!daemon?.url) {
      setReady(true);
      reportError("Daemon URL is required for TUI. Launch with `ohs` or `ohs --tui` so the CLI can start or attach the daemon.");
      return;
    }
    let cancelled = false;
    const client = new OpenHarnessClient({
      baseUrl: daemon.url,
      token: daemon.token ?? undefined,
    });
    clientRef.current = client;

    void (async () => {
      try {
        await client.health();
        const cwd = daemon.cwd ?? process.cwd();
        const [settings, sessions, commands] = await Promise.all([client.getSettings().catch(() => ({}) as Record<string, unknown>), client.listSessions({ cwd, limit: 20 }), client.listCommands({ cwd }).catch(() => [] as CommandCatalogEntry[])]);
        const model = daemon.model ?? stringSetting(settings.model) ?? "default";
        const provider = stringSetting(settings.provider);
        const baseUrl = stringSetting(settings.baseUrl);
        const apiFormat = settings.apiFormat === "anthropic" || settings.apiFormat === "openai" ? settings.apiFormat : undefined;
        defaultRuntimeRef.current = {
          model,
          ...(provider ? { provider } : {}),
          ...(baseUrl ? { baseUrl } : {}),
          ...(apiFormat ? { apiFormat } : {}),
        };
        if (cancelled) return;
        listedSessionsRef.current = Object.fromEntries(sessions.map((session) => [session.id, session]));
        setCommandCatalog(commands);
        setStatus((current) => ({
          ...current,
          model,
          ...(provider ? { provider } : {}),
          cwd,
          permission_mode: daemon?.permissionMode ?? current.permission_mode,
          ...(typeof daemon?.maxTurns === "number" ? { max_turns: daemon.maxTurns } : {}),
          session_mode: statusSessionMode(daemon?.sessionMode),
        }));
        const session = sessions[0];
        if (session && shouldAutoActivateSession(session, model)) {
          activateSession(session);
          void client.getSession(session.id).catch(() => {});
        }
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
  }, [activateSession, daemon?.cwd, daemon?.maxTurns, daemon?.model, daemon?.permissionMode, daemon?.sessionMode, daemon?.token, daemon?.url, reportError]);

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
              pushSystem("reconnecting...");
            }
            continue;
          }
          if (reconnectNotice) reconnectNotice = false;
          commitClientState(update.state, shouldCoalesceClientState(update));
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        reportError(error instanceof Error ? error.message : String(error));
      }
    })();

    return () => {
      clearPendingClientState();
      controller.abort();
    };
  }, [activeSessionId, clearPendingClientState, commitClientState, pushSystem, reportError]);

  useEffect(() => {
    const client = clientRef.current;
    const sessionId = activeSessionId;
    if (!client || !sessionId) return;
    const generation = ++auxiliaryGenerationRef.current;
    const isCurrent = () => activeSessionIdRef.current === sessionId && auxiliaryGenerationRef.current === generation;

    void client.getSessionMcp(sessionId)
      .then((servers) => {
        if (!isCurrent()) return;
        setMcpServers(Array.isArray(servers) ? servers.map(mcpServerSnapshot) : []);
      })
      .catch((error) => {
        if (!isCurrent()) return;
        setMcpServers([]);
        reportError(error instanceof Error ? error.message : String(error));
      });

    void client.listTasks({ sessionId })
      .then((sessionTasks) => {
        if (!isCurrent()) return;
        setTasks(Array.isArray(sessionTasks) ? sessionTasks : []);
      })
      .catch((error) => {
        if (!isCurrent()) return;
        setTasks([]);
        reportError(error instanceof Error ? error.message : String(error));
      });
  }, [activeSessionId, reportError]);

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
    if (!run || run.status === "pending" || run.status === "running") return;
    if (run.status === "failed") {
      reportError(run.error ?? "Agent run failed");
      return;
    }
    setSubmittedRun(null);
  }, [clientState, reportError, submittedRun]);

  const createAndSwitchSession = useCallback(
    async (title?: string): Promise<SessionRecord | undefined> => {
    const client = clientRef.current;
    if (!client) return undefined;
    setLocalBusy(true);
    const cwd = daemon?.cwd ?? process.cwd();
    const model = defaultRuntimeRef.current.model;
    const metadata = sessionRuntimeMetadata({
      model,
      provider: defaultRuntimeRef.current.provider,
      baseUrl: defaultRuntimeRef.current.baseUrl,
      apiFormat: defaultRuntimeRef.current.apiFormat,
      permissionMode: statusRef.current.permission_mode ?? daemon?.permissionMode ?? "default",
      maxTurns: statusRef.current.max_turns ?? daemon?.maxTurns,
      sessionMode: nextSessionModeRef.current,
    });
    const session = await client.createSession({
      cwd,
      model,
      title: title?.trim() || "TUI",
      metadata,
    });
    activateSession(session);
    setSelectRequest(null);
    setLocalBusy(false);
    setSubmittedRun(null);
    pendingNewSessionTitleRef.current = undefined;
    return session;
    },
    [activateSession, daemon?.cwd, daemon?.maxTurns, daemon?.model, daemon?.permissionMode, daemon?.sessionMode],
  );

  useEffect(() => {
    if (!ready || sentInitialPromptRef.current || !config.initial_prompt) return;
    sentInitialPromptRef.current = true;
    const client = clientRef.current;
    if (!client) return;
    setLocalBusy(true);
    void (async () => {
      const session = activeSessionId ? (clientState.sessions[activeSessionId] ?? (await client.getSession(activeSessionId))) : await createAndSwitchSession();
      if (!session) {
        setLocalBusy(false);
        return;
      }
      const response = await client.admitPrompt(session.id, {
        id: createPromptRequestId(),
        content: config.initial_prompt!,
      });
      setLocalBusy(false);
      setSubmittedRun(response.run ? { sessionId: session.id, runId: response.run.id } : null);
    })().catch((error) => reportError(error instanceof Error ? error.message : String(error)));
  }, [activeSessionId, clientState.sessions, config.initial_prompt, createAndSwitchSession, ready, reportError]);

  const refreshWorkflowState = useCallback(
    async (
      input: {
        selectedRunId?: string;
        filters?: WorkflowTuiState["filters"];
        notice?: string;
      } = {},
    ): Promise<void> => {
      const client = clientRef.current;
      const sessionId = activeSessionIdRef.current;
      const generation = ++workflowGenerationRef.current;
      const isCurrent = () => activeSessionIdRef.current === sessionId && workflowGenerationRef.current === generation;
      if (!client || !sessionId) {
        if (!isCurrent()) return;
        setWorkflowStateCurrent(
          workflowStateFromJobs({
            jobs: [],
            filters: input.filters ?? workflowStateRef.current?.filters,
            error: "Open a session before viewing workflow runs.",
          }),
        );
        return;
      }
      try {
        const jobs = await client.listJobs({
          sessionId,
          kinds: ["workflow"],
          includeFinished: true,
        });
        const selectedRunId = input.selectedRunId ?? workflowStateRef.current?.selectedRunId ?? jobs[0]?.id;
        const selected = selectedRunId ? jobs.find((job) => job.id === selectedRunId) : undefined;
        const details = selected ? await client.readJob(selected.id, { sessionId }) : undefined;
        if (!isCurrent()) return;
        setWorkflowStateCurrent(
          workflowStateFromJobs({
            jobs,
            selectedRunId,
            details,
            filters: input.filters ?? workflowStateRef.current?.filters,
            notice: input.notice,
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isCurrent()) return;
        setWorkflowStateCurrent(
          workflowStateFromJobs({
            jobs: [],
            filters: input.filters ?? workflowStateRef.current?.filters,
            error: `Unable to load workflow runs: ${message}`,
          }),
        );
        reportError(message);
      }
    },
    [reportError, setWorkflowStateCurrent],
  );

  const sendRequest = useCallback(
    (action: TuiAction): void => {
    const client = clientRef.current;
    let sessionId = activeSessionIdRef.current;

    void (async () => {
        const runtimeAction = action as TuiAction | { type?: unknown };
        const runtimeType = typeof runtimeAction.type === "string" ? runtimeAction.type : "unknown";
        switch (action.type) {
          case "select_model": {
            if (!client) return;
            const model = action.model.trim();
            const provider = action.provider?.trim() ?? "";
        if (!model) return;

        if (sessionId) {
          const session = await client.updateSession(sessionId, {
                metadata: patchSessionRuntimeMetadata(
                  {},
                  {
              model,
              ...(provider ? { provider } : {}),
                  },
                ),
          });
          activateSession(session);
        } else {
          const settingsPatch: Record<string, unknown> = { model };
          if (provider) settingsPatch.provider = provider;
          await client.patchSettings(settingsPatch);
          defaultRuntimeRef.current = {
            ...defaultRuntimeRef.current,
            model,
            ...(provider ? { provider } : {}),
          };
          setStatus((current) => ({
            ...current,
            model,
            ...(provider ? { provider } : {}),
          }));
        }
        pushSystem(`Model selected: ${model}`);
        return;
      }

          case "submit_line": {
            if (!client) return;
            const line = action.line;
        const slash = parseSlashLine(line);

        const newSession = line.match(/^\/new(?:\s+(.+))?$/);
        if (newSession) {
          returnToHome(newSession[1]);
          return;
        }
        const switchSession = line.match(/^\/sessions\s+open\s+(.+)$/);
        if (switchSession?.[1]) {
          const target = switchSession[1].trim();
          setLocalBusy(false);
          setSubmittedRun(null);
          pendingNewSessionTitleRef.current = undefined;
          setSelectRequest(null);
          const knownSession = clientState.sessions[target] ?? listedSessionsRef.current[target];
          if (knownSession) {
            activateSession(knownSession);
            return;
          }
          const session = await client.getSession(target);
          activateSession(session);
          return;
        }

        if (slash?.name === "/resume") {
          if (!sessionId) {
            pushSystem("No active session to resume.");
            return;
          }
          const recoverable = recoverableInterruptedRuns(clientState.buckets[sessionId]);
          if (!slash.args) {
            if (recoverable.length === 0) {
              pushSystem("No interrupted prompt runs are available to resume.");
              return;
            }
            clearDisplayRequest();
            setSelectRequest({
              title: "Resume interrupted run",
              submitPrefix: "/resume ",
              options: recoverable.map((run) => ({
                value: run.id,
                label: run.prompt.length > 72 ? `${run.prompt.slice(0, 72)}...` : run.prompt,
                description: run.error ?? "Interrupted before completion",
              })),
            });
            return;
          }
          const runId = slash.args.trim();
          if (!recoverable.some((run) => run.id === runId)) {
            pushSystem(`Run is not available for recovery: ${runId}`);
            return;
          }
          setLocalBusy(true);
          const response = await client.resumeInterruptedRun(sessionId, runId, { id: createPromptRequestId() });
          setLocalBusy(false);
          setSubmittedRun(response.run ? { sessionId, runId: response.run.id } : null);
          setSelectRequest(null);
          return;
        }

        const slashResult = await dispatchSessionSlashCommand(slash, {
          client,
          sessionId,
          pushSystem,
          presentSystem: (title, content) => showDisplayRequest({ title, content }),
          statusRef,
          commandCatalogRef,
          clientState,
          localBusy,
          cacheFirstRead,
          daemon,
          setStatus: setStatusAndDefault,
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

        if (!sessionId) {
          const session = await createAndSwitchSession(pendingNewSessionTitleRef.current);
          if (!session) return;
          sessionId = session.id;
        }
        setLocalBusy(true);
            const response = await client.admitPrompt(sessionId, {
              id: createPromptRequestId(),
              content: line,
            });
        setLocalBusy(false);
        setSubmittedRun(response.run ? { sessionId, runId: response.run.id } : null);
        return;
      }

          case "delete_session": {
            if (!client) return;
            const target = action.session_id;
        if (!target) return;
        const archived = await client.archiveSession(target);
        const archivedAt = archived.archivedAt ?? Date.now();
        delete listedSessionsRef.current[target];
        setClientState((current) => archiveClientSession(current, target, archivedAt));
        setLocalBusy(false);
        setSubmittedRun(null);
            setSelectRequest((current) =>
              current
                ? {
                    ...current,
                    options: current.options.filter((option) => option.value !== target),
                  }
                : current,
            );
        if (target === activeSessionIdRef.current) {
          const remaining = listTopLevelSessions(
            Object.values({
              ...clientState.sessions,
              ...listedSessionsRef.current,
              [target]: { ...archived, status: "archived", archivedAt },
            }),
          );
          if (remaining[0]) {
            activateSession(remaining[0]);
          } else {
            const sessions = await client.listSessions({
              cwd: daemon?.cwd ?? undefined,
              includeArchived: false,
              limit: 20,
            });
            listedSessionsRef.current = Object.fromEntries(sessions.map((session) => [session.id, session]));
            const remoteNext = sessions.find((session) => session.id !== target);
            if (remoteNext) activateSession(remoteNext);
            else returnToHome();
          }
        }
        return;
      }

          case "interrupt": {
            if (!client) return;
        if (sessionId) await client.interruptSession(sessionId);
        setLocalBusy(false);
        setSubmittedRun(null);
        return;
      }

          case "permission_response": {
            if (!client) return;
            const requestId = action.request_id;
            const allowed = action.allowed;
        await client.replyPermission(requestId, {
          status: allowed ? "approved" : "denied",
              decision: action.scope === "session" ? "session" : "once",
          clientId: "tui",
        });
        setModal(null);
        return;
      }

          case "list_sessions": {
            if (!client) return;
        const cachedSessions = {
          ...listedSessionsRef.current,
          ...clientState.sessions,
        };
            const cachedOptions = sessionSelectOptions(Object.values(cachedSessions), activeSessionIdRef.current);
        clearDisplayRequest();
        setSelectRequest({
          title: "Sessions",
          submitPrefix: "/sessions open ",
          options: cachedOptions,
        });
        const sessions = await client.listSessions({
          cwd: daemon?.cwd ?? undefined,
          includeArchived: false,
          limit: 20,
        });
        listedSessionsRef.current = Object.fromEntries(sessions.map((session) => [session.id, session]));
            setSelectRequest((current) =>
              current?.submitPrefix === "/sessions open "
          ? {
              title: "Sessions",
              submitPrefix: "/sessions open ",
              options: sessionSelectOptions(sessions, activeSessionIdRef.current),
            }
                : current,
            );
        return;
      }

          case "set_permission_mode": {
            if (!client) return;
            const mode = action.permission_mode;
        setStatus((current) => ({ ...current, permission_mode: mode }));
        if (sessionId) {
          await client.updateSession(sessionId, {
            metadata: patchSessionRuntimeMetadata({}, { permissionMode: mode }),
          });
        }
        return;
      }

          case "question_response": {
            if (!client) return;
            reportError("Interactive question responses are not available through the daemon client.");
            return;
          }

          case "set_session_mode": {
            if (!client) return;
        if (sessionId) {
          pushSystem("Coordinator mode can only be changed before starting a new session. Use /new first.");
          return;
        }
            const mode = normalizeSessionMode(action.session_mode);
        nextSessionModeRef.current = statusSessionMode(mode);
            setStatus((current) => ({
              ...current,
              session_mode: nextSessionModeRef.current,
            }));
            return;
          }

          case "workflow_request": {
            if (!client) {
              const message = "The daemon client is not connected.";
              setWorkflowStateCurrent(workflowStateFromJobs({ jobs: [], error: message }));
              reportError(message);
              return;
            }
            const workflowAction = action.workflow_action;
            const current = workflowStateRef.current;
            switch (workflowAction) {
              case "open":
              case "refresh":
                await refreshWorkflowState();
                return;
              case "select_run":
                await refreshWorkflowState({
                  selectedRunId: action.workflow_run_id,
                });
                return;
              case "set_filter": {
                const filters = {
                  ...current?.filters,
                  ...(action.workflow_task_id !== undefined ? { taskId: action.workflow_task_id || undefined } : {}),
                  ...(action.workflow_status !== undefined ? { status: action.workflow_status || undefined } : {}),
                };
                await refreshWorkflowState({
                  selectedRunId: current?.selectedRunId,
                  filters,
                });
                return;
              }
              case "clear_filters":
                await refreshWorkflowState({
                  selectedRunId: current?.selectedRunId,
                  filters: {},
                });
                return;
              case "cancel": {
                const runId = action.workflow_run_id ?? current?.selectedRunId;
                const workflowSessionId = activeSessionIdRef.current;
                if (!workflowSessionId || !runId) {
                  const message = "Select a workflow run before cancelling it.";
                  setWorkflowStateCurrent(current ? { ...current, error: message } : workflowStateFromJobs({ jobs: [], error: message }));
                  reportError(message);
        return;
      }
                await client.cancelJob(runId, {
                  sessionId: workflowSessionId,
                  reason: action.workflow_cancel_reason,
                });
                await refreshWorkflowState({
                  selectedRunId: runId,
                  notice: `Cancellation requested for ${runId}.`,
                });
                return;
              }
              default: {
                const exhaustive: never = workflowAction;
                reportError(`Unsupported workflow action: ${String(exhaustive)}`);
                return;
              }
            }
          }

          default: {
            const exhaustive: never = action;
            void exhaustive;
            reportError(`Unsupported TUI action: ${runtimeType}`);
            return;
          }
        }
    })().catch((error) => {
      reportError(error instanceof Error ? error.message : String(error));
    });
    },
    [activeSessionId, activateSession, cacheFirstRead, clearDisplayRequest, clientState, createAndSwitchSession, daemon, localBusy, pushSystem, refreshWorkflowState, reportError, returnToHome, setWorkflowStateCurrent, showDisplayRequest],
  );

  const bucket = activeSessionId ? clientState.buckets[activeSessionId] : undefined;
  const recoveryItems = useMemo(
    () =>
      recoverableInterruptedRuns(bucket).map((run) => ({
      id: `recovery:${run.id}`,
      role: "system" as const,
      text: `Run interrupted${run.error ? `: ${run.error}` : ""}\nUse /resume ${run.id} to replay its original prompt.`,
    })),
    [bucket],
  );
  const transcriptView = useMemo(() => {
    const base = splitStreamingAssistant(bucketToTranscript(bucket));
    return {
      transcript: [...base.items, ...recoveryItems, ...(activeSessionId ? (systemItemsBySession[activeSessionId] ?? []) : globalSystemItems)],
      assistantBuffer: base.assistantBuffer,
    };
  }, [activeSessionId, bucket, globalSystemItems, recoveryItems, systemItemsBySession]);
  const submittedRunRecord = submittedRun ? clientState.buckets[submittedRun.sessionId]?.runs[submittedRun.runId] : undefined;
  const waitingForSubmittedRun = !!submittedRun && (!submittedRunRecord || submittedRunRecord.status === "pending" || submittedRunRecord.status === "running");
  const commandDetails = useMemo(() => mergeCommandDetails(commandCatalog), [commandCatalog]);
  const commands = useMemo(() => commandDetails.map((entry) => entry.name), [commandDetails]);

  return useMemo(
    () => ({
      transcript: transcriptView.transcript,
      assistantBuffer: transcriptView.assistantBuffer,
      status,
      tasks,
      commands,
      commandDetails,
      mcpServers,
      modal,
      selectRequest,
      displayRequest,
      busy: localBusy || running || waitingForSubmittedRun,
      ready,
      workflowState,
      setModal,
      setSelectRequest,
      setDisplayRequest,
      setBusy: setLocalBusy,
      loadModels,
      sendRequest,
    }),
    [commandDetails, commands, displayRequest, loadModels, localBusy, mcpServers, modal, ready, running, selectRequest, sendRequest, status, tasks, transcriptView, waitingForSubmittedRun, workflowState],
  );
}
