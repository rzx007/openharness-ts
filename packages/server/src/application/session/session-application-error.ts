import { ApplicationError } from "../../shared/application-error.js";

export class SessionApplicationError extends ApplicationError {
  constructor(
    status: 400 | 404 | 409 | 500,
    message: string,
  ) {
    super(status, message);
    this.name = "SessionApplicationError";
  }
}
