import type { ContextSensitivity } from "@openharness/context";

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/u,
  /\b(?:api[_ -]?key|access[_ -]?token|password|密码|密钥)\s*(?:是|为|:|=)\s*\S+/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
];

const IPV4_PATTERN = /\b(?<a>\d{1,3})\.(?<b>\d{1,3})\.(?<c>\d{1,3})\.(?<d>\d{1,3})\b/gu;

export function detectContextSensitivity(content: string): ContextSensitivity {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) return "secret";
  for (const match of content.matchAll(IPV4_PATTERN)) {
    const a = Number(match.groups?.a);
    const b = Number(match.groups?.b);
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "sensitive";
  }
  return "none";
}

export function containsSecret(content: string): boolean {
  return detectContextSensitivity(content) === "secret";
}
