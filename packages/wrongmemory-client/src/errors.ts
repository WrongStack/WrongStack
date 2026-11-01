// Vendored from WrongMemory (https://github.com/WrongStack/wrongmemory) commit 40f7275,
// file packages/client-ts/src/errors.ts. Do not edit here; update upstream and re-vendor.
import type { ClientErrorCode, ErrorBody, ErrorCode } from './contracts.js';

/** Typed failure: daemon error codes plus client-side transport classes. */
export class WrongMemoryError extends Error {
  readonly code: ErrorCode | ClientErrorCode;
  readonly retryable: boolean;

  constructor(code: ErrorCode | ClientErrorCode, message: string, retryable = false) {
    super(`${code}: ${message}`);
    this.name = 'WrongMemoryError';
    this.code = code;
    this.retryable = retryable;
  }

  static fromBody(body: ErrorBody): WrongMemoryError {
    return new WrongMemoryError(body.code, body.message, body.retryable);
  }
}

export function isWrongMemoryError(e: unknown, code?: string): e is WrongMemoryError {
  return e instanceof WrongMemoryError && (code === undefined || e.code === code);
}
