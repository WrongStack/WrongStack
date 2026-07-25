/**
 * Surface the OS error code (EACCES, ENOSPC, ...) alongside the message in
 * storage.* event payloads. Codes are stable and locale-independent.
 */
export function storageErrorString(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${code}: ${err.message}` : err.message;
  }
  /* v8 ignore next -- defensive: callers only pass fs Error instances */
  return String(err);
}
