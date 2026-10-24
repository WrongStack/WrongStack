import type { ProviderError } from './provider.js';

export interface RetryPolicy {
  shouldRetry(err: ProviderError | Error, attempt: number): boolean;
  delayMs(attempt: number, err?: ProviderError | Error): number;
  maxAttempts(err: ProviderError | Error): number;
}
