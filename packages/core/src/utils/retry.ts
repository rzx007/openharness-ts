export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  retryableStatusCodes?: number[];
  retryableErrors?: string[];
  getRetryAfter?: (error: any) => number | undefined;
}

const DEFAULT_RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 529];

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000,
  options?: RetryOptions
): Promise<T> {
  const maxDelay = options?.maxDelay ?? 30_000;
  const retryableStatusCodes = options?.retryableStatusCodes ?? DEFAULT_RETRYABLE_STATUS_CODES;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt === maxRetries) break;

      if (!isRetryable(error, retryableStatusCodes, options?.retryableErrors)) break;

      let delay: number;
      const retryAfter = options?.getRetryAfter?.(error);
      if (retryAfter !== undefined && retryAfter > 0) {
        delay = Math.min(retryAfter * 1000, maxDelay);
      } else {
        const jitter = Math.random() * 1000;
        delay = Math.min(baseDelay * 2 ** attempt + jitter, maxDelay);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

function isRetryable(
  error: any,
  statusCodes: number[],
  retryableErrors?: string[]
): boolean {
  const status = error?.status ?? error?.statusCode ?? error?.error?.status;
  if (status && statusCodes.includes(status)) return true;

  const code = error?.code;
  if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ENOTFOUND") {
    return true;
  }

  if (retryableErrors) {
    const msg = error?.message ?? String(error);
    for (const pattern of retryableErrors) {
      if (msg.includes(pattern)) return true;
    }
  }

  return false;
}
