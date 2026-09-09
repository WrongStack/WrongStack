import type { ACPSessionErrorKind } from './acp-session-types.js';

export class ACPSessionError extends Error {
  readonly kind: ACPSessionErrorKind;
  override readonly cause: unknown;
  constructor(kind: ACPSessionErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = 'ACPSessionError';
    this.kind = kind;
    this.cause = cause;
  }
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export function isJsonRpcError(v: unknown): v is JsonRpcError {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { code?: unknown }).code === 'number' &&
    typeof (v as { message?: unknown }).message === 'string'
  );
}

/**
 * True when an agent refused `session/new` (or similar) because the user
 * must authenticate first. Official registry agents often return this
 * (~19/31 in the 2026-09 protocol matrix) instead of creating a session.
 */
export function isAuthRequiredError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (/auth(_|-)?required|authentication required/i.test(message)) return true;
  const cause =
    err instanceof ACPSessionError
      ? err.cause
      : err && typeof err === 'object' && 'cause' in err
        ? (err as { cause: unknown }).cause
        : err;
  if (!cause || typeof cause !== 'object') return false;
  const data = (cause as { data?: unknown }).data;
  if (data === 'auth_required' || data === 'AUTH_REQUIRED') return true;
  if (data && typeof data === 'object') {
    const d = data as { authRequired?: unknown; code?: unknown };
    if (d.authRequired === true) return true;
    if (d.code === 'auth_required' || d.code === 'AUTH_REQUIRED') return true;
  }
  return false;
}
