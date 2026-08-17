export const DEFAULT_MAX_OUTPUT_CHARS = 12_000;

function normalize(raw: string): string {
  return raw.replace(/\r\n/g, "\n").trim();
}

export function decodeShellChunk(chunk: Buffer | string): string {
  if (typeof chunk === "string") return chunk;

  // Windows WSL launch errors are commonly emitted as UTF-16LE.
  if (looksLikeUtf16Le(chunk)) {
    return chunk.toString("utf16le");
  }
  return chunk.toString("utf8");
}

export function looksLikeUtf16Le(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  const sampleLength = Math.min(buffer.length, 200);
  let oddNulls = 0;
  let evenNulls = 0;

  for (let index = 0; index < sampleLength; index++) {
    if (buffer[index] !== 0) continue;
    if (index % 2 === 0) {
      evenNulls++;
    } else {
      oddNulls++;
    }
  }

  const pairs = Math.floor(sampleLength / 2);
  return oddNulls > pairs * 0.25 && evenNulls < pairs * 0.05;
}

export function formatOutput(raw: string, maxChars = DEFAULT_MAX_OUTPUT_CHARS): string {
  const text = normalize(raw);
  if (!text) return "(no output)";
  if (text.length > maxChars) {
    return `${text.slice(0, maxChars)}\n...[truncated]...`;
  }
  return text;
}
