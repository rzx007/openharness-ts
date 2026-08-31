export type PreviewKind = "file" | "markdown" | "code-block" | "diff"
export type PreviewMode = "highlighted" | "plain" | "paused"
export type PreviewLimitReason = "characters" | "lines" | "line-length"

export interface PreviewMetrics {
  characterCount: number
  lineCount: number
  maxLineLength: number
}

export interface PreviewDecision {
  kind: PreviewKind
  mode: PreviewMode
  reason: PreviewLimitReason | null
  metrics: PreviewMetrics
}

interface PreviewLimit {
  characters: number
  lines: number
  lineLength: number
}

export const previewLimits: Record<PreviewKind, PreviewLimit> = {
  file: { characters: 200_000, lines: 5_000, lineLength: 10_000 },
  markdown: { characters: 300_000, lines: 8_000, lineLength: 20_000 },
  "code-block": { characters: 100_000, lines: 2_000, lineLength: 5_000 },
  diff: { characters: 300_000, lines: 10_000, lineLength: 10_000 },
}

export function analyzePreviewContent(content: string): PreviewMetrics {
  let lineCount = 1
  let currentLineLength = 0
  let maxLineLength = 0

  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) !== 10) {
      currentLineLength += 1
      continue
    }

    const lineLength =
      index > 0 && content.charCodeAt(index - 1) === 13
        ? currentLineLength - 1
        : currentLineLength
    maxLineLength = Math.max(maxLineLength, lineLength)
    currentLineLength = 0
    lineCount += 1
  }

  return {
    characterCount: content.length,
    lineCount,
    maxLineLength: Math.max(maxLineLength, currentLineLength),
  }
}

export function resolvePreviewDecision(kind: PreviewKind, content: string): PreviewDecision {
  const metrics = analyzePreviewContent(content)
  const limits = previewLimits[kind]
  const reason = resolveLimitReason(metrics, limits)

  return {
    kind,
    mode: reason === null ? "highlighted" : kind === "markdown" ? "paused" : "plain",
    reason,
    metrics,
  }
}

function resolveLimitReason(
  metrics: PreviewMetrics,
  limits: PreviewLimit
): PreviewLimitReason | null {
  if (metrics.characterCount > limits.characters) return "characters"
  if (metrics.lineCount > limits.lines) return "lines"
  if (metrics.maxLineLength > limits.lineLength) return "line-length"
  return null
}
