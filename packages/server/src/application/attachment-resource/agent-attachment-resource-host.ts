import type {
  AgentAttachmentResourceHost,
  AgentAttachmentTextSlice,
} from "@openharness/core";
import {
  classifyAttachmentCandidate,
  type AttachmentApplicationService,
  type SessionStore,
} from "@openharness/services";

export interface AgentAttachmentResourceHostOptions {
  store: SessionStore;
  attachments: AttachmentApplicationService;
  resolveAuthorizationSessionId?(sessionId: string): string | undefined;
}

export function createAgentAttachmentResourceHost(
  options: AgentAttachmentResourceHostOptions,
): AgentAttachmentResourceHost {
  return {
    async readText(input, context): Promise<AgentAttachmentTextSlice> {
      context.signal?.throwIfAborted();
      if (!context.sessionId) throw resourceDenied();
      validateRange(input.offset, input.limit);
      const authorizationSessionId =
        options.resolveAuthorizationSessionId?.(context.sessionId) ?? context.sessionId;
      const reference = authorizedReference(
        options.store,
        authorizationSessionId,
        input.assetId,
      );
      if (!reference) throw resourceDenied();
      const asset = readyAsset(options.attachments, input.assetId);
      if (asset.status !== "ready") throw resourceUnavailable();
      if (classifyAttachmentCandidate({
        displayName: reference.displayName,
        mediaType: reference.mediaType,
      }) !== "text") {
        throw resourceDenied();
      }
      const decoded = await options.attachments.readReadyText(input.assetId, {
        ...(context.signal ? { signal: context.signal } : {}),
      });
      context.signal?.throwIfAborted();
      const lines = decoded.text.split("\n");
      if (input.offset > lines.length) throw new Error("attachment_resource_range_invalid");
      const startIndex = input.offset - 1;
      const selected = lines.slice(startIndex, startIndex + input.limit);
      return {
        displayName: decoded.displayName,
        mediaType: decoded.mediaType,
        encoding: decoded.encoding,
        content: selected.join("\n"),
        startLine: input.offset,
        endLine: input.offset + selected.length - 1,
        hasMore: startIndex + selected.length < lines.length,
      };
    },
  };
}

function authorizedReference(
  store: SessionStore,
  sessionId: string,
  assetId: string,
) {
  try {
    return store
      .listSessionInputAttachments(sessionId)
      .find((candidate) => candidate.assetId === assetId);
  } catch {
    throw resourceDenied();
  }
}

function readyAsset(attachments: AttachmentApplicationService, assetId: string) {
  try {
    return attachments.get(assetId);
  } catch {
    throw resourceUnavailable();
  }
}

function validateRange(offset: number, limit: number): void {
  if (!Number.isSafeInteger(offset) || offset < 1 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 2_000) {
    throw new Error("attachment_resource_range_invalid");
  }
}

function resourceDenied(): Error {
  return new Error("attachment_resource_access_denied");
}

function resourceUnavailable(): Error {
  return new Error("attachment_resource_unavailable");
}
