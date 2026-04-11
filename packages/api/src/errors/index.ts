export class AuthenticationFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationFailure";
  }
}

export class RateLimitFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitFailure";
  }
}

export class RequestFailure extends Error {
  constructor(
    message: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = "RequestFailure";
  }
}
