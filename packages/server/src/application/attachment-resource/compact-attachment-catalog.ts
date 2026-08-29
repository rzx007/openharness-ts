import type { CompactAttachmentCatalog } from "@openharness/core";
import type {
  AttachmentAssetRecord,
  AttachmentRepresentationRecord,
  SessionInputAttachmentRecord,
} from "@openharness/protocol";

export interface CompactAttachmentCatalogStore {
  listSessionInputAttachments(sessionId: string): SessionInputAttachmentRecord[];
  getAttachment(
    assetId: string,
    options?: { includeDeleted?: boolean },
  ): AttachmentAssetRecord | undefined;
  listAttachmentRepresentations(assetId: string): AttachmentRepresentationRecord[];
}

export interface CompactAttachmentCatalogOptions {
  maxEntries?: number;
  maxPreviewChars?: number;
}

export function buildCompactAttachmentCatalog(
  store: CompactAttachmentCatalogStore,
  sessionId: string,
  options: CompactAttachmentCatalogOptions = {},
): CompactAttachmentCatalog {
  const maxEntries = positiveLimit(options.maxEntries, 20);
  const maxPreviewChars = positiveLimit(options.maxPreviewChars, 1_000);
  const references = store.listSessionInputAttachments(sessionId);
  const selected = references.slice(-maxEntries);
  return {
    entries: selected.map((reference) => {
      const asset = store.getAttachment(reference.assetId, {
        includeDeleted: true,
      });
      const available = asset?.status === "ready";
      const entry: CompactAttachmentCatalog["entries"][number] = {
        assetId: reference.assetId,
        inputId: reference.inputId,
        displayName: reference.displayName,
        mediaType: reference.mediaType,
        sizeBytes: reference.sizeBytes,
        intent: reference.intent,
        status: available ? "available" : "unavailable",
        access: available
          ? accessFor(reference.mediaType, reference.intent)
          : "unavailable",
      };
      if (available) {
        entry.resourceUri = attachmentResourceUri(
          reference.assetId,
          reference.displayName,
        );
        const representation = store
          .listAttachmentRepresentations(reference.assetId)
          .filter((candidate) =>
            candidate.status === "completed" &&
            typeof candidate.text === "string"
          )
          .sort((left, right) =>
            right.updatedAt - left.updatedAt || right.createdAt - left.createdAt
          )[0];
        if (representation?.text !== undefined) {
          entry.representation = {
            kind: representation.kind,
            processor: representation.processor,
            processorVersion: representation.processorVersion,
            textPreview: representation.text.slice(0, maxPreviewChars),
            truncated: representation.text.length > maxPreviewChars,
          };
        }
      }
      return entry;
    }),
    omittedCount: Math.max(0, references.length - selected.length),
  };
}

function accessFor(
  mediaType: string,
  intent: SessionInputAttachmentRecord["intent"],
): CompactAttachmentCatalog["entries"][number]["access"] {
  if (mediaType.startsWith("image/")) return "image_to_text";
  if (
    mediaType.startsWith("text/") ||
    intent === "tool_resource" ||
    ["application/json", "application/xml", "application/yaml", "application/toml"]
      .includes(mediaType)
  ) {
    return "read_text";
  }
  return "unavailable";
}

function attachmentResourceUri(assetId: string, displayName: string): string {
  return `attachment://${assetId}/${encodeURIComponent(displayName)}`;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}
