import type {
  Message,
  StreamEvent,
  ContentBlock,
  ToolUseBlock,
  IHookExecutor,
} from "../index";
import { estimateTokens } from "../utils/token-counter";

// ---------------------------------------------------------------------------
// Constants (aligned with Python openharness v0.1.9 services/compact)
// ---------------------------------------------------------------------------

const COMPACTABLE_TOOLS = [
  "Bash", "Read", "Write", "Edit", "Glob", "Grep",
  "WebFetch", "WebSearch",
];

const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_PTL_RETRIES = 3;

const TIME_BASED_MC_CLEARED_MESSAGE = "[Old tool result content cleared]";
const PTL_RETRY_MARKER = "[earlier conversation truncated for compaction retry]";

// Context collapse — deterministic shrink of oversized text/tool results.
const CONTEXT_COLLAPSE_TEXT_CHAR_LIMIT = 2_400;
const CONTEXT_COLLAPSE_HEAD_CHARS = 900;
const CONTEXT_COLLAPSE_TAIL_CHARS = 500;

// Token estimation padding (conservative, matches Python 4/3).
const TOKEN_ESTIMATION_PADDING = 4 / 3;
const DEFAULT_VISION_IMAGE_TOKEN_ESTIMATE = 3_072;

const COMPACT_PROMPT = `Summarize the following conversation between the user and an AI assistant.

Produce your summary in two sections:

<analysis>
- Briefly describe what the user was trying to accomplish
- What approach was taken
- Key findings and decisions made
- Any errors encountered and how they were resolved
</analysis>

<summary>
- Concise narrative of the conversation progress
- Key state: files modified, tools used, results obtained
- Any pending items or follow-up actions needed
</summary>

Keep the summary concise and focused on information needed for continuing the task.`;

// ---------------------------------------------------------------------------
// Public callback / progress types
// ---------------------------------------------------------------------------

export type CompactTrigger = "auto" | "manual" | "reactive";

export type CompactProgressPhase =
  | "context_collapse_start"
  | "context_collapse_end"
  | "compact_start"
  | "compact_retry"
  | "compact_end"
  | "compact_failed";

export interface CompactProgressEvent {
  phase: CompactProgressPhase;
  trigger: CompactTrigger;
  message?: string;
  attempt?: number;
  checkpoint?: string;
  metadata?: Record<string, unknown>;
}

export type CompactProgressCallback = (
  event: CompactProgressEvent,
) => void | Promise<void>;

export interface CompactCheckpoint {
  checkpoint: string;
  trigger: CompactTrigger;
  messageCount: number;
  tokenCount: number;
  attempt?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Compact attachments (B.2) — structured context injected into the summary prompt.
// ---------------------------------------------------------------------------

/** 压缩摘要时附加的结构化上下文（对齐 Python compact attachments）。 */
export interface CompactAttachments {
  /** 当前正在进行的任务描述（来自 TaskManager）。 */
  taskFocus?: string;
  /** 本会话访问过的文件路径（auto-extracted 或外部注入）。 */
  recentFiles?: string[];
  /** 当前计划/TODO 内容。 */
  plan?: string;
  /** 工具调用摘要（auto-derived from history）。 */
  workLog?: string;
}

/** 由调用方（QueryEngine / CLI）提供外部上下文。 */
export type CompactAttachmentsProvider = () =>
  | CompactAttachments
  | Promise<CompactAttachments>;

export interface CompactServiceOptions {
  client?: CompactClient;
  hookExecutor?: IHookExecutor;
  progressCallback?: CompactProgressCallback;
  imageTokenEstimate?: number;
  attachmentsProvider?: CompactAttachmentsProvider;
}

export interface CompactClient {
  submitMessage(content: string): AsyncIterable<StreamEvent>;
}

// ---------------------------------------------------------------------------
// Error classification — detect llama.cpp / OpenAI-compatible context overflow
// ---------------------------------------------------------------------------

const PTL_NEEDLES = [
  "prompt too long",
  "context_length_exceeded",
  "context length",
  "maximum context",
  "context window",
  "input tokens exceed",
  "messages resulted in",
  "reduce the length of the messages",
  "configured limit",
  "too many tokens",
  "too large for the model",
  "maximum context length",
  "exceed_context",
  "exceeds the available context size",
  "available context size",
];

export function isPromptTooLongError(err: unknown): boolean {
  const text = String(
    err instanceof Error ? err.message : err,
  ).toLowerCase();
  return PTL_NEEDLES.some((needle) => text.includes(needle));
}

// ---------------------------------------------------------------------------
// Message helpers — the TS Message model is a discriminated union.
// ---------------------------------------------------------------------------

function isTextBlock(block: ContentBlock): block is { type: "text"; text: string } {
  return block.type === "text";
}

function isImageBlock(block: ContentBlock): boolean {
  return block.type === "image";
}

/** Stringify message content for token estimation / summarization text. */
function contentToText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
}

/** Tool-use ids emitted by an assistant message. */
function toolUseIds(msg: Message): string[] {
  if (msg.type !== "assistant" || !msg.toolUses) return [];
  return msg.toolUses.map((tu) => tu.id);
}

/** Tool-result id satisfied by a tool_result message. */
function toolResultId(msg: Message): string | undefined {
  return msg.type === "tool_result" ? msg.toolUseId : undefined;
}

// ---------------------------------------------------------------------------
// CompactService
// ---------------------------------------------------------------------------

export class CompactService {
  private maxTokens: number;
  private keepRecent: number;
  private client: CompactClient | undefined;
  private hookExecutor: IHookExecutor | undefined;
  private progressCallback: CompactProgressCallback | undefined;
  private imageTokenEstimate: number;
  private consecutiveFailures = 0;
  private checkpoints: CompactCheckpoint[] = [];
  private attachmentsProvider: CompactAttachmentsProvider | undefined;

  constructor(
    maxTokens = 100_000,
    keepRecent = 10,
    clientOrOptions?: CompactClient | CompactServiceOptions,
  ) {
    this.maxTokens = maxTokens;
    this.keepRecent = keepRecent;

    // Backward-compatible: third arg was historically a bare CompactClient.
    if (clientOrOptions && "submitMessage" in clientOrOptions) {
      this.client = clientOrOptions;
      this.hookExecutor = undefined;
      this.progressCallback = undefined;
      this.imageTokenEstimate = DEFAULT_VISION_IMAGE_TOKEN_ESTIMATE;
    } else {
      const opts = (clientOrOptions ?? {}) as CompactServiceOptions;
      this.client = opts.client;
      this.hookExecutor = opts.hookExecutor;
      this.progressCallback = opts.progressCallback;
      this.imageTokenEstimate =
        opts.imageTokenEstimate ?? DEFAULT_VISION_IMAGE_TOKEN_ESTIMATE;
      this.attachmentsProvider = opts.attachmentsProvider;
    }
  }

  /** Replace the summarizer client (e.g. when switching API client). */
  setClient(client: CompactClient | undefined): void {
    this.client = client;
  }

  /** 注册/替换附件提供者（由 QueryEngine 或 CLI 接线后注入 TaskManager 等上下文）。 */
  setAttachmentsProvider(fn: CompactAttachmentsProvider | undefined): void {
    this.attachmentsProvider = fn;
  }

  // -------------------------------------------------------------------------
  // Attachments helpers (B.2)
  // -------------------------------------------------------------------------

  /** 从消息历史自动提取最近访问的文件路径（Read/Write/Edit 工具 file_path 字段）。 */
  private extractRecentFiles(messages: Message[]): string[] {
    const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit"]);
    const seen = new Set<string>();
    const files: string[] = [];
    for (const msg of messages) {
      if (msg.type === "assistant" && msg.toolUses) {
        for (const tu of msg.toolUses) {
          if (FILE_TOOLS.has(tu.name)) {
            const fp = (tu.input as Record<string, unknown>)?.file_path;
            if (typeof fp === "string" && !seen.has(fp)) {
              seen.add(fp);
              files.push(fp);
            }
          }
        }
      }
    }
    return files.slice(-20);
  }

  /** 从消息历史派生工具调用摘要（tool×count 格式）。 */
  private deriveWorkLog(messages: Message[]): string | undefined {
    const counts = new Map<string, number>();
    for (const msg of messages) {
      if (msg.type === "assistant" && msg.toolUses) {
        for (const tu of msg.toolUses) {
          counts.set(tu.name, (counts.get(tu.name) ?? 0) + 1);
        }
      }
    }
    if (counts.size === 0) return undefined;
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name}×${count}`)
      .join(", ");
  }

  /** 构建附带结构化上下文的 compact prompt。 */
  private buildCompactPrompt(attachments: CompactAttachments): string {
    const sections: string[] = [];
    if (attachments.taskFocus) {
      sections.push(`## Current Task\n${attachments.taskFocus}`);
    }
    if (attachments.recentFiles?.length) {
      sections.push(`## Recently Accessed Files\n${attachments.recentFiles.join("\n")}`);
    }
    if (attachments.plan) {
      sections.push(`## Current Plan\n${attachments.plan}`);
    }
    if (attachments.workLog) {
      sections.push(`## Work Log\n${attachments.workLog}`);
    }
    if (sections.length === 0) return COMPACT_PROMPT;
    return (
      COMPACT_PROMPT +
      "\n\n<context>\n" +
      sections.join("\n\n") +
      "\n</context>\n\nIncorporate the above context into your summary to help resume work effectively."
    );
  }

  /** Wire a hook executor so PRE/POST_COMPACT events fire. */
  setHookExecutor(executor: IHookExecutor | undefined): void {
    this.hookExecutor = executor;
  }

  /** Register a progress callback. */
  setProgressCallback(cb: CompactProgressCallback | undefined): void {
    this.progressCallback = cb;
  }

  /** Compact checkpoints recorded during the last/ongoing run (core subset). */
  getCheckpoints(): CompactCheckpoint[] {
    return [...this.checkpoints];
  }

  // -------------------------------------------------------------------------
  // Auto-compact entry point (called by QueryEngine each turn)
  // -------------------------------------------------------------------------

  async autoCompact(
    messages: Message[],
    trigger: CompactTrigger = "auto",
  ): Promise<Message[]> {
    const estimated = this.estimateTokens(messages);
    const threshold =
      this.maxTokens - MAX_OUTPUT_TOKENS_FOR_SUMMARY - AUTOCOMPACT_BUFFER_TOKENS;

    if (estimated < threshold) return messages;

    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      return this.microCompact(messages);
    }

    // Cheap pass: clear old tool results. May be enough on its own.
    let working = this.microCompact(messages);
    if (this.estimateTokens(working) < threshold) {
      return working;
    }

    // Deterministic context collapse (no model call) — fallback bound.
    const collapsed = this.tryContextCollapse(working);
    if (collapsed) {
      await this.emitProgress({
        phase: "context_collapse_start",
        trigger,
        message: "Collapsing oversized context before full compaction.",
        checkpoint: "context_collapse_start",
      });
      working = collapsed;
      await this.emitProgress({
        phase: "context_collapse_end",
        trigger,
        message: "Context collapse complete.",
        checkpoint: "context_collapse_end",
        metadata: this.recordCheckpoint("context_collapse_end", trigger, working),
      });
      if (this.estimateTokens(working) < threshold) {
        return working;
      }
    }

    if (this.client) {
      try {
        const result = await this.llmCompact(working, trigger);
        this.consecutiveFailures = 0;
        return result;
      } catch (err) {
        this.consecutiveFailures++;
        await this.emitProgress({
          phase: "compact_failed",
          trigger,
          message: String(err instanceof Error ? err.message : err),
          checkpoint: "compact_failed",
          metadata: this.recordCheckpoint("compact_failed", trigger, working, {
            reason: String(err instanceof Error ? err.message : err),
            consecutiveFailures: this.consecutiveFailures,
          }),
        });
      }
    }

    return this.simpleCompact(working);
  }

  // -------------------------------------------------------------------------
  // Simple compact — placeholder summary (legacy fallback, kept for compat)
  // -------------------------------------------------------------------------

  simpleCompact(messages: Message[]): Message[] {
    const systemMessages = messages.filter((m) => m.type === "system");
    const nonSystem = messages.filter((m) => m.type !== "system");

    const { older, recent } = this.splitPreservingToolPairs(nonSystem);
    if (older.length === 0) return messages;

    const compactedCount = older.length;
    const toolResultCount = older.filter((m) => m.type === "tool_result").length;

    const summary: Message = {
      type: "assistant",
      content: `[Conversation compacted: ${compactedCount} messages summarized (${toolResultCount} tool results removed). ${recent.length} recent messages preserved.]`,
    };

    const boundary = this.createBoundaryMarker({
      trigger: "auto",
      compactKind: "simple",
      preMessageCount: messages.length,
      postMessageCount: systemMessages.length + 1 + recent.length,
    });

    return [...systemMessages, summary, boundary, ...recent];
  }

  // -------------------------------------------------------------------------
  // Microcompact — clear old compactable tool results cheaply.
  // -------------------------------------------------------------------------

  microCompact(messages: Message[]): Message[] {
    // Collect ordered tool_use ids whose result is compactable, then keep the
    // most recent keepRecent and clear the rest.
    const toolNameById = new Map<string, string>();
    for (const msg of messages) {
      if (msg.type === "assistant" && msg.toolUses) {
        for (const tu of msg.toolUses) toolNameById.set(tu.id, tu.name);
      }
    }

    const compactableIds: string[] = [];
    for (const msg of messages) {
      if (msg.type === "tool_result") {
        // Unknown / unmatched tool results default to *retained* (matches
        // Python `_collect_compactable_tool_ids`, which only clears results for
        // tools in COMPACTABLE_TOOLS). Do not over-clear orphaned results.
        const name = toolNameById.get(msg.toolUseId) ?? "";
        if (COMPACTABLE_TOOLS.includes(name)) {
          compactableIds.push(msg.toolUseId);
        }
      }
    }

    const keepCount = Math.max(1, this.keepRecent);
    if (compactableIds.length <= keepCount) {
      return messages;
    }
    const clearSet = new Set(
      compactableIds.slice(0, compactableIds.length - keepCount),
    );

    return messages.map((msg) => {
      if (msg.type !== "tool_result" || !clearSet.has(msg.toolUseId)) {
        return msg;
      }
      const alreadyCleared =
        msg.content.length === 1 &&
        isTextBlock(msg.content[0]!) &&
        (msg.content[0] as { text: string }).text === TIME_BASED_MC_CLEARED_MESSAGE;
      if (alreadyCleared) return msg;
      return {
        ...msg,
        content: [{ type: "text" as const, text: TIME_BASED_MC_CLEARED_MESSAGE }],
      };
    });
  }

  // -------------------------------------------------------------------------
  // Context collapse — deterministic shrink of oversized text/tool results.
  // -------------------------------------------------------------------------

  tryContextCollapse(messages: Message[]): Message[] | null {
    if (messages.length <= this.keepRecent + 2) return null;

    const { older, recent } = this.splitPreservingToolPairs(messages);
    let changed = false;

    const collapsedOlder = older.map((msg) => {
      if (msg.type === "user" && Array.isArray(msg.content)) {
        const blocks = msg.content.map((b) => {
          if (isTextBlock(b)) {
            const collapsed = this.collapseText(b.text);
            if (collapsed !== b.text) changed = true;
            return { type: "text" as const, text: collapsed };
          }
          return b;
        });
        return { ...msg, content: blocks } as Message;
      }
      if (msg.type === "user" && typeof msg.content === "string") {
        const collapsed = this.collapseText(msg.content);
        if (collapsed !== msg.content) changed = true;
        return { ...msg, content: collapsed } as Message;
      }
      if (msg.type === "assistant") {
        const collapsed = this.collapseText(msg.content);
        if (collapsed !== msg.content) changed = true;
        return { ...msg, content: collapsed } as Message;
      }
      if (msg.type === "tool_result") {
        const blocks = msg.content.map((b) => {
          if (isTextBlock(b)) {
            const collapsed = this.collapseText(b.text);
            if (collapsed !== b.text) changed = true;
            return { type: "text" as const, text: collapsed };
          }
          return b;
        });
        return { ...msg, content: blocks } as Message;
      }
      return msg;
    });

    if (!changed) return null;

    const result = [...collapsedOlder, ...recent];
    if (this.estimateTokens(result) >= this.estimateTokens(messages)) {
      return null;
    }
    return result;
  }

  private collapseText(text: string): string {
    if (text.length <= CONTEXT_COLLAPSE_TEXT_CHAR_LIMIT) return text;
    const omitted =
      text.length - CONTEXT_COLLAPSE_HEAD_CHARS - CONTEXT_COLLAPSE_TAIL_CHARS;
    const head = text.slice(0, CONTEXT_COLLAPSE_HEAD_CHARS).trimEnd();
    const tail = text.slice(-CONTEXT_COLLAPSE_TAIL_CHARS).trimStart();
    return `${head}\n...[collapsed ${omitted} chars]...\n${tail}`;
  }

  // -------------------------------------------------------------------------
  // LLM compact — call the summarizer, with PTL head-truncation retries.
  // -------------------------------------------------------------------------

  private async llmCompact(
    messages: Message[],
    trigger: CompactTrigger,
  ): Promise<Message[]> {
    if (!this.client) throw new Error("No LLM client");

    const systemMessages = messages.filter((m) => m.type === "system");
    const nonSystem = messages.filter((m) => m.type !== "system");

    const { older, recent } = this.splitPreservingToolPairs(nonSystem);
    if (!older.length) return messages;

    const preTokens = this.estimateTokens(messages);

    // PRE_COMPACT hook
    if (this.hookExecutor) {
      const hookResult = await this.hookExecutor.execute("pre_compact", {
        trigger,
        messageCount: messages.length,
        tokenCount: preTokens,
        preserveRecent: this.keepRecent,
        discoveredTools: this.extractDiscoveredTools(older),
      });
      if (hookResult.blocked) {
        // Blocked: skip compaction, leave messages intact.
        this.recordCheckpoint("compact_blocked", trigger, messages, {
          reason: hookResult.reason ?? "pre-compact hook blocked compaction",
        });
        return messages;
      }
    }

    await this.emitProgress({
      phase: "compact_start",
      trigger,
      message: "Compacting conversation memory.",
      checkpoint: "compact_start",
      metadata: this.recordCheckpoint("compact_start", trigger, messages),
    });

    // Build the summarizer request from older messages, with image payloads
    // replaced by placeholders (do not ship big images to the summarizer).
    let summarizable = this.replaceImagesWithPlaceholders(older);

    // Gather compact attachments (B.2): auto-derived + provider-supplied.
    const autoFiles = this.extractRecentFiles(messages);
    const autoWorkLog = this.deriveWorkLog(messages);
    let attachments: CompactAttachments = {
      recentFiles: autoFiles.length > 0 ? autoFiles : undefined,
      workLog: autoWorkLog,
    };
    if (this.attachmentsProvider) {
      const external = await this.attachmentsProvider();
      attachments = {
        taskFocus: external.taskFocus ?? attachments.taskFocus,
        recentFiles: external.recentFiles ?? attachments.recentFiles,
        plan: external.plan ?? attachments.plan,
        workLog: external.workLog ?? attachments.workLog,
      };
    }
    const compactPrompt = this.buildCompactPrompt(attachments);

    let summaryText = "";
    let ptlRetries = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        summaryText = await this.collectSummary(summarizable, compactPrompt);
        break;
      } catch (err) {
        if (isPromptTooLongError(err) && ptlRetries < MAX_PTL_RETRIES) {
          const truncated = this.truncateHeadForPtlRetry(summarizable);
          if (truncated) {
            ptlRetries++;
            summarizable = truncated;
            await this.emitProgress({
              phase: "compact_retry",
              trigger,
              message:
                "Compaction prompt was too large; retrying with older context trimmed.",
              attempt: ptlRetries,
              checkpoint: "compact_retry_prompt_too_long",
              metadata: this.recordCheckpoint(
                "compact_retry_prompt_too_long",
                trigger,
                summarizable,
                { ptlRetries },
              ),
            });
            continue;
          }
        }
        throw err;
      }
    }

    const formatted = this.formatSummary(summaryText) ||
      "[Conversation compacted via LLM summary]";

    const summary: Message = {
      type: "assistant",
      content: formatted,
    };

    const postCount = systemMessages.length + 1 + 1 + recent.length;
    const boundary = this.createBoundaryMarker({
      trigger,
      compactKind: "full",
      preMessageCount: messages.length,
      preTokenCount: preTokens,
      postMessageCount: postCount,
      usedHeadTruncationRetry: ptlRetries > 0,
    });

    // POST_COMPACT hook
    if (this.hookExecutor) {
      await this.hookExecutor.execute("post_compact", {
        trigger,
        preCompactMessageCount: messages.length,
        postCompactMessageCount: postCount,
        preCompactTokens: preTokens,
        postCompactTokens: this.estimateTokens([summary, ...recent]),
        usedHeadTruncationRetry: ptlRetries > 0,
      });
    }

    const result = [...systemMessages, summary, boundary, ...recent];
    await this.emitProgress({
      phase: "compact_end",
      trigger,
      message: "Conversation compaction complete.",
      checkpoint: "compact_end",
      metadata: this.recordCheckpoint("compact_end", trigger, result, {
        preCompactTokens: preTokens,
        postCompactTokens: this.estimateTokens(result),
        ptlRetries,
      }),
    });
    return result;
  }

  private async collectSummary(messages: Message[], customPrompt?: string): Promise<string> {
    if (!this.client) throw new Error("No LLM client");

    const conversationText = messages
      .map((m) => {
        const role =
          m.type === "user"
            ? "User"
            : m.type === "assistant"
              ? "Assistant"
              : m.type === "tool_result"
                ? "ToolResult"
                : "System";
        const content =
          typeof m.content === "string"
            ? m.content
            : JSON.stringify(m.content);
        return `${role}: ${content.slice(0, 4000)}`;
      })
      .join("\n\n");

    const basePrompt = customPrompt ?? COMPACT_PROMPT;
    const prompt = `${basePrompt}\n\n<conversation>\n${conversationText}\n</conversation>`;

    let summaryText = "";
    for await (const event of this.client.submitMessage(prompt)) {
      if (event.type === "text_delta") {
        summaryText += event.delta;
      } else if (event.type === "error") {
        throw event.error;
      }
    }
    if (!summaryText.trim()) {
      throw new Error("Compaction interrupted before a complete summary was returned.");
    }
    return summaryText;
  }

  private formatSummary(raw: string): string {
    // Strip the <analysis> scratchpad; surface <summary> content.
    let text = raw.replace(/<analysis>[\s\S]*?<\/analysis>/g, "");
    const m = text.match(/<summary>([\s\S]*?)<\/summary>/);
    if (m) {
      text = text.replace(m[0], `Summary:\n${m[1]!.trim()}`);
    }
    return text.replace(/\n\n+/g, "\n\n").trim();
  }

  // -------------------------------------------------------------------------
  // PTL head truncation — drop oldest prompt rounds, keep a retry marker.
  // -------------------------------------------------------------------------

  truncateHeadForPtlRetry(messages: Message[]): Message[] | null {
    const groups = this.groupByPromptRound(messages);
    if (groups.length < 2) return null;

    let dropCount = Math.max(1, Math.floor(groups.length / 5));
    dropCount = Math.min(dropCount, groups.length - 1);

    const retained = groups.slice(dropCount).flat();
    if (!retained.length) return null;

    if (retained[0]!.type === "assistant" || retained[0]!.type === "tool_result") {
      const marker: Message = { type: "user", content: PTL_RETRY_MARKER };
      return [marker, ...retained];
    }
    return retained;
  }

  private groupByPromptRound(messages: Message[]): Message[][] {
    const groups: Message[][] = [];
    let current: Message[] = [];
    for (const msg of messages) {
      const startsNewRound =
        msg.type === "user" && contentToText(msg.content).trim().length > 0;
      if (startsNewRound && current.length) {
        groups.push(current);
        current = [];
      }
      current.push(msg);
    }
    if (current.length) groups.push(current);
    return groups;
  }

  // -------------------------------------------------------------------------
  // Tool pairing protection — never split a tool_use from its tool_result.
  // -------------------------------------------------------------------------

  /**
   * Split messages into older/recent at a keepRecent boundary, walking the
   * boundary back so a tool_use (assistant) and its tool_result (the following
   * user/tool_result message) are never separated.
   */
  splitPreservingToolPairs(messages: Message[]): {
    older: Message[];
    recent: Message[];
  } {
    if (messages.length <= this.keepRecent) {
      return { older: [], recent: [...messages] };
    }
    let splitIndex = Math.max(0, messages.length - this.keepRecent);
    while (
      splitIndex > 0 &&
      this.boundaryCrossesToolPair(messages[splitIndex - 1]!, messages, splitIndex)
    ) {
      splitIndex--;
    }
    return {
      older: messages.slice(0, splitIndex),
      recent: messages.slice(splitIndex),
    };
  }

  /**
   * True when keeping `messages[splitIndex..]` recent would orphan a tool_use
   * in `previous` whose matching tool_result sits at/after splitIndex.
   */
  private boundaryCrossesToolPair(
    previous: Message,
    messages: Message[],
    splitIndex: number,
  ): boolean {
    const pendingIds = new Set(toolUseIds(previous));
    if (pendingIds.size === 0) return false;
    // Does the recent segment carry any of the pending tool_result ids?
    for (let i = splitIndex; i < messages.length; i++) {
      const rid = toolResultId(messages[i]!);
      if (rid && pendingIds.has(rid)) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Image handling
  // -------------------------------------------------------------------------

  /** Replace image blocks with placeholder text for summarizer requests. */
  replaceImagesWithPlaceholders(messages: Message[]): Message[] {
    return messages.map((msg) => {
      if (msg.type === "user" && Array.isArray(msg.content)) {
        if (!msg.content.some(isImageBlock)) return msg;
        return {
          ...msg,
          content: msg.content.map((b) =>
            isImageBlock(b)
              ? { type: "text" as const, text: "[Image omitted from compaction summarization.]" }
              : b,
          ),
        } as Message;
      }
      if (msg.type === "tool_result") {
        if (!msg.content.some(isImageBlock)) return msg;
        return {
          ...msg,
          content: msg.content.map((b) =>
            isImageBlock(b)
              ? { type: "text" as const, text: "[Image omitted from compaction summarization.]" }
              : b,
          ),
        } as Message;
      }
      return msg;
    });
  }

  // -------------------------------------------------------------------------
  // Boundary marker
  // -------------------------------------------------------------------------

  createBoundaryMarker(metadata: {
    trigger: CompactTrigger;
    compactKind: string;
    preMessageCount?: number;
    preTokenCount?: number;
    postMessageCount?: number;
    usedHeadTruncationRetry?: boolean;
  }): Message {
    const lines = [
      "[Compact boundary marker]",
      "Earlier conversation was compacted. Use the summary above and the messages below as the continuity boundary.",
      `Trigger: ${metadata.trigger}`,
      `Compaction kind: ${metadata.compactKind}`,
    ];
    if (metadata.preMessageCount !== undefined) {
      lines.push(
        `Pre-compact footprint: messages=${metadata.preMessageCount}` +
          (metadata.preTokenCount !== undefined
            ? `, tokens=${metadata.preTokenCount}`
            : ""),
      );
    }
    if (metadata.postMessageCount !== undefined) {
      lines.push(`Post-compact footprint: messages=${metadata.postMessageCount}`);
    }
    if (metadata.usedHeadTruncationRetry) {
      lines.push("Note: older context was head-truncated during a PTL retry.");
    }
    return { type: "user", content: lines.join("\n") };
  }

  // -------------------------------------------------------------------------
  // Token estimation — includes images (each ~imageTokenEstimate tokens).
  // -------------------------------------------------------------------------

  estimateTokens(messages: Message[]): number {
    let total = 0;
    for (const msg of messages) {
      if (msg.type === "assistant") {
        total += estimateTokens(msg.content);
        if (msg.toolUses) {
          for (const tu of msg.toolUses) {
            total += estimateTokens(tu.name);
            total += estimateTokens(JSON.stringify(tu.input));
          }
        }
        continue;
      }
      if (typeof msg.content === "string") {
        total += estimateTokens(msg.content);
        continue;
      }
      for (const block of msg.content) {
        if (block.type === "text") {
          total += estimateTokens(block.text);
        } else if (block.type === "image") {
          total += this.imageTokenEstimate;
        }
      }
    }
    return Math.ceil(total * TOKEN_ESTIMATION_PADDING);
  }

  // -------------------------------------------------------------------------
  // Internal: discovered tools, progress, checkpoints
  // -------------------------------------------------------------------------

  private extractDiscoveredTools(messages: Message[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const msg of messages) {
      if (msg.type === "assistant" && msg.toolUses) {
        for (const tu of msg.toolUses) {
          if (tu.name && !seen.has(tu.name)) {
            seen.add(tu.name);
            out.push(tu.name);
          }
        }
      }
    }
    return out;
  }

  private recordCheckpoint(
    checkpoint: string,
    trigger: CompactTrigger,
    messages: Message[],
    details?: Record<string, unknown>,
  ): CompactCheckpoint {
    const payload: CompactCheckpoint = {
      checkpoint,
      trigger,
      messageCount: messages.length,
      tokenCount: this.estimateTokens(messages),
      ...(details ?? {}),
    };
    this.checkpoints.push(payload);
    return payload;
  }

  private async emitProgress(event: CompactProgressEvent): Promise<void> {
    if (!this.progressCallback) return;
    await this.progressCallback(event);
  }
}

// ToolUseBlock re-export is intentionally omitted; consumers import from index.
export type { ToolUseBlock };
