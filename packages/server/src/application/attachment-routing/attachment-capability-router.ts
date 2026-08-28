import type { ContentBlock } from "@openharness/core";
import type { ResolvedAttachmentContentPath } from "@openharness/services";

import {
  AttachmentRoutingError,
  type AttachmentRoutingDecision,
  type AttachmentRoutingErrorCode,
  type NativeAttachmentRouteResult,
  type RouteAttachmentBatchInput,
} from "./attachment-routing-types.js";

export interface AttachmentCapabilityRouterOptions {
  resolveReadyContentPath(
    assetId: string,
  ): Promise<ResolvedAttachmentContentPath>;
}

export class AttachmentCapabilityRouter {
  constructor(private readonly options: AttachmentCapabilityRouterOptions) {}

  async route(
    input: RouteAttachmentBatchInput,
  ): Promise<NativeAttachmentRouteResult> {
    throwIfAborted(input.signal, input.attachments.map((item) => item.assetId));
    const attachments = [...input.attachments].sort(
      (left, right) => left.seq - right.seq,
    );
    const assetIds = attachments.map((item) => item.assetId);

    const capabilityError = capabilityFailure(input);
    if (capabilityError) {
      throw blocked(capabilityError, assetIds, attachments.map((item) => ({
        assetId: item.assetId,
        intent: item.intent,
        mediaType: item.mediaType,
        route: "blocked" as const,
        reason: capabilityError,
      })));
    }

    const decisions: AttachmentRoutingDecision[] = [];
    for (const attachment of attachments) {
      const reason = attachmentFailure(
        attachment.intent,
        attachment.mediaType,
        input.providerCapabilities.imageMediaTypes,
      );
      const decision: AttachmentRoutingDecision = {
        assetId: attachment.assetId,
        intent: attachment.intent,
        mediaType: attachment.mediaType,
        route: reason ? "blocked" : "native_image",
        ...(reason ? { reason } : {}),
      };
      decisions.push(decision);
      if (reason) throw blocked(reason, assetIds, decisions);
    }

    const resolved: ResolvedAttachmentContentPath[] = [];
    try {
      for (const attachment of attachments) {
        throwIfAborted(input.signal, assetIds, decisions);
        const content = await this.options.resolveReadyContentPath(
          attachment.assetId,
        );
        throwIfAborted(input.signal, assetIds, decisions);
        if (
          content.assetId !== attachment.assetId ||
          content.mediaType !== attachment.mediaType ||
          content.sizeBytes !== attachment.sizeBytes
        ) {
          throw new Error("attachment metadata changed during routing");
        }
        resolved.push(content);
      }
    } catch (error) {
      if (error instanceof AttachmentRoutingError) throw error;
      throw blocked("attachment_materialization_failed", assetIds, decisions);
    }

    const content: ContentBlock[] = [];
    if (input.text.trim().length > 0) {
      content.push({ type: "text", text: input.text });
    }
    for (const item of resolved) {
      content.push({
        type: "image",
        source: {
          type: "file",
          mediaType: item.mediaType,
          path: item.path,
          sizeBytes: item.sizeBytes,
        },
      });
    }
    return { content, decisions };
  }
}

function capabilityFailure(
  input: RouteAttachmentBatchInput,
): AttachmentRoutingErrorCode | undefined {
  if (input.modelCapabilities.image === "unknown") {
    return "attachment_model_capability_unknown";
  }
  if (input.modelCapabilities.image === "unsupported") {
    return "attachment_model_unsupported";
  }
  if (input.providerCapabilities.image === "unknown") {
    return "attachment_provider_capability_unknown";
  }
  if (input.providerCapabilities.image === "unsupported") {
    return "attachment_provider_unsupported";
  }
  return undefined;
}

function attachmentFailure(
  intent: RouteAttachmentBatchInput["attachments"][number]["intent"],
  mediaType: string,
  supportedMediaTypes: readonly string[],
): AttachmentRoutingErrorCode | undefined {
  if (intent !== "auto" && intent !== "vision") {
    return "attachment_intent_unavailable";
  }
  if (!mediaType.startsWith("image/")) return "attachment_kind_unsupported";
  if (!supportedMediaTypes.includes(mediaType)) {
    return "attachment_media_type_unsupported";
  }
  return undefined;
}

function blocked(
  code: AttachmentRoutingErrorCode,
  assetIds: string[],
  decisions: AttachmentRoutingDecision[],
): AttachmentRoutingError {
  return new AttachmentRoutingError(
    code,
    routingErrorMessage(code),
    assetIds,
    decisions,
  );
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  assetIds: string[],
  decisions: AttachmentRoutingDecision[] = [],
): void {
  if (signal?.aborted) {
    throw blocked("attachment_routing_aborted", assetIds, decisions);
  }
}

function routingErrorMessage(code: AttachmentRoutingErrorCode): string {
  switch (code) {
    case "attachment_model_capability_unknown":
      return "model image capability is unknown";
    case "attachment_model_unsupported":
      return "model does not support image input";
    case "attachment_provider_capability_unknown":
      return "provider image capability is unknown";
    case "attachment_provider_unsupported":
      return "provider does not support image input";
    case "attachment_intent_unavailable":
      return "the requested attachment intent is not available";
    case "attachment_kind_unsupported":
      return "attachment kind is not supported for native image input";
    case "attachment_media_type_unsupported":
      return "attachment media type is not supported by the provider";
    case "attachment_materialization_failed":
      return "attachment content could not be materialized";
    case "attachment_routing_aborted":
      return "attachment routing was aborted";
  }
}
