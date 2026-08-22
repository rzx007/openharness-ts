import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";

/** 后台任务日志在磁盘上的默认上限。只保留最新的内容。 */
export const MAX_PERSISTED_EXECUTION_OUTPUT_BYTES = 10 * 1024 * 1024;

export function appendBoundedOutput(
  path: string,
  data: string | Buffer,
  maxBytes = MAX_PERSISTED_EXECUTION_OUTPUT_BYTES,
): void {
  const incoming = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (incoming.length >= maxBytes) {
    writeFileSync(path, incoming.subarray(incoming.length - maxBytes));
    return;
  }

  const existingBytes = existsSync(path) ? statSync(path).size : 0;
  if (existingBytes + incoming.length <= maxBytes) {
    appendFileSync(path, incoming);
    return;
  }

  const keepExistingBytes = maxBytes - incoming.length;
  const tail = Buffer.alloc(Math.min(existingBytes, keepExistingBytes));
  if (tail.length > 0) {
    const file = openSync(path, "r");
    try {
      readSync(file, tail, 0, tail.length, existingBytes - tail.length);
    } finally {
      closeSync(file);
    }
  }
  writeFileSync(path, Buffer.concat([tail, incoming]));
}

export function writeBoundedOutput(
  path: string,
  data: string | Buffer,
  maxBytes = MAX_PERSISTED_EXECUTION_OUTPUT_BYTES,
): void {
  const content = Buffer.isBuffer(data) ? data : Buffer.from(data);
  writeFileSync(path, content.length > maxBytes ? content.subarray(content.length - maxBytes) : content);
}
