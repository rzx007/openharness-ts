import { normalizeContextContent } from "./normalize.js";
import type {
  ContextDocumentSegment,
  ContextEntryRecord,
  ContextKind,
  ContextOrigin,
  ContextScope,
  ContextSensitivity,
  ContextTopic,
  ContextTopicDocument,
} from "./types.js";

const ENTRY_START = "<!-- context-entry\n";
const ENTRY_END = "<!-- /context-entry -->";

type Frontmatter = {
  schema_version: 2;
  scope: ContextScope;
  scope_key: string;
  topic: ContextTopic;
  title: string;
  updated_at: string;
};

type EntryMetadata = {
  id: string;
  kind: ContextKind;
  semantic_key: string;
  normalized_content: string;
  status: ContextEntryRecord["status"];
  sensitivity: ContextSensitivity;
  confidence: number;
  importance: number;
  origin: ContextOrigin;
  source_session_id?: string;
  source_message_id?: string;
  supersedes_id?: string;
  candidate_reason?: string;
  use_count: number;
  last_used_at?: string;
  created_at: string;
  updated_at: string;
};

export function renderContextDocument(document: ContextTopicDocument): string {
  assertUniqueIds(document.segments);
  const frontmatter: Frontmatter = {
    schema_version: document.schemaVersion,
    scope: document.scope,
    scope_key: document.scopeKey,
    topic: document.topic,
    title: document.title,
    updated_at: toIso(document.updatedAt),
  };
  return `---\n${stringifyRecord(frontmatter)}\n---\n${document.segments.map(renderSegment).join("")}`;
}

export function parseContextDocument(markdown: string): ContextTopicDocument {
  if (!markdown.startsWith("---\n")) throw new Error("Context document frontmatter is missing");
  const frontmatterEnd = markdown.indexOf("\n---\n", 4);
  if (frontmatterEnd < 0) throw new Error("Context document frontmatter is unclosed");
  const frontmatter = parseRecord(markdown.slice(4, frontmatterEnd)) as Frontmatter;
  const body = markdown.slice(frontmatterEnd + 5);
  const segments = parseSegments(body, frontmatter);
  assertUniqueIds(segments);
  return {
    schemaVersion: frontmatter.schema_version,
    scope: frontmatter.scope,
    scopeKey: frontmatter.scope_key,
    topic: frontmatter.topic,
    title: frontmatter.title,
    updatedAt: Date.parse(frontmatter.updated_at),
    segments,
  };
}

export function listDocumentEntries(document: ContextTopicDocument): ContextEntryRecord[] {
  return document.segments.flatMap((segment) => segment.type === "entry" ? [segment.entry] : []);
}

function renderSegment(segment: ContextDocumentSegment): string {
  if (segment.type === "text") return segment.content;
  const entry = segment.entry;
  const metadata: EntryMetadata = {
    id: entry.id,
    kind: entry.kind,
    semantic_key: entry.semanticKey,
    normalized_content: entry.normalizedContent,
    status: entry.status,
    sensitivity: entry.sensitivity,
    confidence: entry.confidence,
    importance: entry.importance,
    origin: entry.origin,
    ...(entry.sourceSessionId ? { source_session_id: entry.sourceSessionId } : {}),
    ...(entry.sourceMessageId ? { source_message_id: entry.sourceMessageId } : {}),
    ...(entry.supersedesId ? { supersedes_id: entry.supersedesId } : {}),
    ...(entry.candidateReason ? { candidate_reason: entry.candidateReason } : {}),
    use_count: entry.useCount,
    ...(entry.lastUsedAt === undefined ? {} : { last_used_at: toIso(entry.lastUsedAt) }),
    created_at: toIso(entry.createdAt),
    updated_at: toIso(entry.updatedAt),
  };
  return `${ENTRY_START}${stringifyRecord(metadata)}\n-->\n\n## ${entry.title}\n\n${entry.content}\n\n${ENTRY_END}`;
}

function parseSegments(body: string, frontmatter: Frontmatter): ContextDocumentSegment[] {
  const segments: ContextDocumentSegment[] = [];
  let cursor = 0;
  while (cursor < body.length) {
    const start = body.indexOf(ENTRY_START, cursor);
    if (start < 0) {
      if (body.includes(ENTRY_END, cursor)) throw new Error("Unexpected closing context-entry block");
      if (cursor < body.length) segments.push({ type: "text", content: body.slice(cursor) });
      break;
    }
    if (start > cursor) segments.push({ type: "text", content: body.slice(cursor, start) });
    const metadataEnd = body.indexOf("\n-->\n\n", start + ENTRY_START.length);
    const entryBodyStart = metadataEnd + "\n-->\n\n".length;
    const close = metadataEnd < 0 ? -1 : body.indexOf(`\n\n${ENTRY_END}`, entryBodyStart);
    if (metadataEnd < 0 || close < 0) throw new Error("Unclosed context-entry block");
    const nestedStart = body.indexOf(ENTRY_START, entryBodyStart);
    if (nestedStart >= 0 && nestedStart < close) throw new Error("Unclosed context-entry block");
    const metadata = parseRecord(body.slice(start + ENTRY_START.length, metadataEnd)) as EntryMetadata;
    const entryBody = body.slice(entryBodyStart, close);
    const titleEnd = entryBody.indexOf("\n\n");
    if (!entryBody.startsWith("## ") || titleEnd < 0) throw new Error(`Invalid context-entry body for ${metadata.id}`);
    segments.push({
      type: "entry",
      entry: {
        id: metadata.id,
        title: entryBody.slice(3, titleEnd),
        scope: frontmatter.scope,
        scopeKey: frontmatter.scope_key,
        kind: metadata.kind,
        semanticKey: metadata.semantic_key,
        topic: frontmatter.topic,
        content: entryBody.slice(titleEnd + 2),
        normalizedContent: metadata.normalized_content ?? normalizeContextContent(entryBody.slice(titleEnd + 2)),
        status: metadata.status,
        sensitivity: metadata.sensitivity,
        confidence: metadata.confidence,
        importance: metadata.importance,
        origin: metadata.origin,
        ...(metadata.source_session_id ? { sourceSessionId: metadata.source_session_id } : {}),
        ...(metadata.source_message_id ? { sourceMessageId: metadata.source_message_id } : {}),
        ...(metadata.supersedes_id ? { supersedesId: metadata.supersedes_id } : {}),
        ...(metadata.candidate_reason ? { candidateReason: metadata.candidate_reason } : {}),
        useCount: metadata.use_count,
        ...(metadata.last_used_at ? { lastUsedAt: Date.parse(metadata.last_used_at) } : {}),
        createdAt: Date.parse(metadata.created_at),
        updatedAt: Date.parse(metadata.updated_at),
      },
    });
    cursor = close + 2 + ENTRY_END.length;
  }
  return segments;
}

function assertUniqueIds(segments: ContextDocumentSegment[]): void {
  const ids = new Set<string>();
  for (const entry of segments.flatMap((segment) => segment.type === "entry" ? [segment.entry] : [])) {
    if (ids.has(entry.id)) throw new Error(`Duplicate context entry id: ${entry.id}`);
    ids.add(entry.id);
  }
}

function toIso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function stringifyRecord(record: object): string {
  return Object.entries(record)
    .map(([key, value]) => `${key}: ${typeof value === "number" ? String(value) : JSON.stringify(value)}`)
    .join("\n");
}

function parseRecord(source: string): unknown {
  return Object.fromEntries(source.split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf(": ");
    if (separator < 1) throw new Error(`Invalid context metadata line: ${line}`);
    const key = line.slice(0, separator);
    const rawValue = line.slice(separator + 2);
    if (/^-?(?:\d+\.?\d*|\.\d+)$/u.test(rawValue)) return [key, Number(rawValue)];
    try {
      return [key, JSON.parse(rawValue)];
    } catch {
      throw new Error(`Invalid context metadata value for ${key}`);
    }
  }));
}
