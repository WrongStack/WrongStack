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
