function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function contentBlocks(message: unknown): unknown[] {
  const record = asRecord(message);
  return Array.isArray(record?.content) ? record.content : [];
}

export function toolUseIds(message: unknown): string[] {
  const record = asRecord(message);
  if (!record) return [];

  if (Array.isArray(record.toolUses)) {
    return record.toolUses
      .map((block) => asRecord(block)?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }

  if (Array.isArray(record.tool_calls)) {
    return record.tool_calls
      .map((block) => asRecord(block)?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }

  return contentBlocks(message)
    .filter((block) => asRecord(block)?.type === "tool_use")
    .map((block) => asRecord(block)?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

function hasToolUseMessage(message: unknown): boolean {
  const record = asRecord(message);
  if (!record) return false;
  if (Array.isArray(record.toolUses) && record.toolUses.length > 0) return true;
  if (Array.isArray(record.tool_calls) && record.tool_calls.length > 0) return true;
  return contentBlocks(message).some((block) => asRecord(block)?.type === "tool_use");
}

export function isToolResultMessage(message: unknown): boolean {
  const record = asRecord(message);
  if (!record) return false;
  if (record.type === "tool_result" || record.role === "tool_result" || record.role === "tool") return true;

  const blocks = contentBlocks(message);
  return blocks.length > 0 && blocks.every((block) => asRecord(block)?.type === "tool_result");
}

export function toolResultId(message: unknown): string | undefined {
  const record = asRecord(message);
  if (!record) return undefined;

  for (const key of ["toolUseId", "tool_use_id", "tool_call_id", "id"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }

  for (const block of contentBlocks(message)) {
    const blockRecord = asRecord(block);
    if (blockRecord?.type !== "tool_result") continue;
    for (const key of ["toolUseId", "tool_use_id", "tool_call_id", "id"]) {
      const value = blockRecord[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }

  return undefined;
}

export function sanitizeMessageHistory<T>(messages: readonly T[]): T[] {
  const kept: T[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    const hasToolUse = hasToolUseMessage(message);
    const expectedIds = toolUseIds(message);

    if (hasToolUse) {
      const expected = new Set(expectedIds);
      const matched = new Set<string>();
      const results: T[] = [];
      let cursor = i + 1;

      while (cursor < messages.length && isToolResultMessage(messages[cursor])) {
        const result = messages[cursor]!;
        const id = toolResultId(result);
        if (id && expected.has(id) && !matched.has(id)) {
          matched.add(id);
          results.push(result);
        }
        cursor++;
      }

      if (expectedIds.length > 0 && expectedIds.every((id) => matched.has(id))) {
        kept.push(message, ...results);
      }
      i = cursor - 1;
      continue;
    }

    if (isToolResultMessage(message)) continue;
    kept.push(message);
  }

  return kept;
}

export function boundaryFallsInsideToolGroup(messages: readonly unknown[], splitIndex: number): boolean {
  for (let i = 0; i < splitIndex; i++) {
    const ids = new Set(toolUseIds(messages[i]));
    if (ids.size === 0) continue;

    let lastResultIndex = i;
    for (let j = i + 1; j < messages.length; j++) {
      if (!isToolResultMessage(messages[j])) break;
      const id = toolResultId(messages[j]);
      if (!id) break;
      if (ids.has(id)) {
        lastResultIndex = j;
      }
    }

    if (splitIndex > i && splitIndex <= lastResultIndex) return true;
  }

  return false;
}
