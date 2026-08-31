import { createHash } from "node:crypto";

export function normalizeContextContent(content: string): string {
  return content
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/[。.!！?？]+$/u, "")
    .trim()
    .toLocaleLowerCase("en-US");
}

export function createContentSignature(content: string): string {
  return createHash("sha256").update(normalizeContextContent(content)).digest("hex");
}
