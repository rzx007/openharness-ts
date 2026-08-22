export class SessionApplicationError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 500,
    message: string,
  ) {
    super(message);
    this.name = "SessionApplicationError";
  }
}
