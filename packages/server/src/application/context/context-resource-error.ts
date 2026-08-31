export class ContextResourceError extends Error {
  constructor(readonly code: "not_found" | "secret" | "sensitive" | "invalid", message: string) {
    super(message);
  }
}
