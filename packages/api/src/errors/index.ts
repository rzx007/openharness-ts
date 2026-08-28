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

export class ProviderCapabilityMismatchFailure extends RequestFailure {
  readonly code = "provider_capability_mismatch";

  constructor(message: string, statusCode = 400) {
    super(message, statusCode);
    this.name = "ProviderCapabilityMismatchFailure";
  }
}

export function requestFailure(message: string, statusCode?: number): RequestFailure {
  if (
    statusCode === 400 &&
    /(?:image|vision|multimodal|media[_ -]?type)/i.test(message) &&
    /(?:unsupported|not support|does not support|invalid|cannot|can't)/i.test(message)
  ) {
    return new ProviderCapabilityMismatchFailure(message, statusCode);
  }
  return new RequestFailure(message, statusCode);
}
