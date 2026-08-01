import type {
  CommandCatalogEntry,
  OpenHarnessClient,
  OpenHarnessClientState,
  SlashLine,
} from "@openharness/client";
import {
  LOCAL_COMMAND_DETAILS,
  LOCAL_COMMAND_NAMES,
  dispatchSessionCommand,
  hasActiveRun,
  mergeCommandDetails,
  parseSlashLine,
  resolveSessionCwd,
} from "@openharness/client";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import type { FrontendConfig } from "../types";

export {
  LOCAL_COMMAND_DETAILS,
  LOCAL_COMMAND_NAMES,
  hasActiveRun,
  mergeCommandDetails,
  parseSlashLine,
};

export type SessionSlashCtx = {
  client: OpenHarnessClient;
  sessionId: string | undefined;
  pushSystem: (text: string) => void;
  statusRef: MutableRefObject<Record<string, unknown>>;
  commandCatalogRef: MutableRefObject<CommandCatalogEntry[]>;
  clientState: OpenHarnessClientState;
  localBusy: boolean;
  daemon?: FrontendConfig["daemon"];
  setStatus: Dispatch<SetStateAction<Record<string, unknown>>>;
};

export async function dispatchSessionSlashCommand(
  slash: SlashLine | null,
  ctx: SessionSlashCtx,
): Promise<"handled" | "unhandled" | "local_ui_ignored"> {
  const {
    client,
    sessionId,
    pushSystem,
    statusRef,
    commandCatalogRef,
    clientState,
    localBusy,
    daemon,
    setStatus,
  } = ctx;

  const outcome = await dispatchSessionCommand(slash, {
    client,
    sessionId,
    cwd: resolveSessionCwd({
      statusCwd: statusRef.current.cwd,
      daemonCwd: daemon?.cwd ?? undefined,
    }),
    model: statusRef.current.model != null
      ? String(statusRef.current.model)
      : daemon?.model ?? undefined,
    permissionMode: typeof statusRef.current.permission_mode === "string"
      ? statusRef.current.permission_mode
      : undefined,
    statusSessionId: typeof statusRef.current.session_id === "string"
      ? statusRef.current.session_id
      : sessionId,
    commandCatalog: commandCatalogRef.current,
    clientState,
    busy: localBusy,
    emit: pushSystem,
    patchStatus: (patch) => setStatus((current) => ({ ...current, ...patch })),
  });

  if (outcome === "local_ui") return "local_ui_ignored";
  return outcome;
}
