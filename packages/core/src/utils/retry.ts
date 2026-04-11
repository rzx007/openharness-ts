export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt === maxRetries) break;

      const jitter = Math.random() * 1000;
      const delay = Math.min(baseDelay * 2 ** attempt + jitter, 30_000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
