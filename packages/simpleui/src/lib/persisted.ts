/**
 * Versioned, quota-aware localStorage persistence for SimpleUI.
 *
 * Every payload is stored as an envelope `{ v: number; d: T }`. Reads accept
 * two shapes:
 *  - a current-version envelope (validated through `validate`);
 *  - a legacy un-enveloped payload (also validated) so existing user data
 *    survives the introduction of versioning.
 * A payload written by a *newer* version or failing validation is discarded
 * (returns null) instead of poisoning the UI.
 *
 * Write failures — most importantly browser quota exhaustion — are reported to
 * subscribers via {@link onPersistedWriteFailure} so the app can surface a
 * notice instead of silently losing drafts or prompts.
 */

export interface PersistedStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface PersistedEnvelope {
  v: number;
  d: unknown;
}

export type PersistedWriteFailureReason = 'quota' | 'error';

export type PersistedWriteFailureListener = (
  key: string,
  reason: PersistedWriteFailureReason,
) => void;

const writeFailureListeners = new Set<PersistedWriteFailureListener>();

/** Subscribe to persistence write failures. Returns an unsubscribe function. */
export function onPersistedWriteFailure(listener: PersistedWriteFailureListener): () => void {
  writeFailureListeners.add(listener);
  return () => writeFailureListeners.delete(listener);
}

function notifyWriteFailure(key: string, reason: PersistedWriteFailureReason): void {
  for (const listener of writeFailureListeners) {
    try {
      listener(key, reason);
    } catch {
      // A broken subscriber must not break persistence for the others.
    }
  }
}

/** Heuristic for the QuotaExceededError family (browsers are inconsistent). */
function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' ||
      error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      error.code === 22)
  );
}

function browserStorage(): PersistedStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Read a persisted value. Returns the validated payload, or null when the
 * storage is unavailable, the key is missing, or the payload is corrupt /
 * from an incompatible future version.
 */
export function readPersisted<T>(
  key: string,
  options: { version: number; validate: (value: unknown) => T | null; storage?: PersistedStorage },
): T | null {
  const storage = options.storage ?? browserStorage();
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'v' in parsed &&
      'd' in parsed &&
      typeof (parsed as PersistedEnvelope).v === 'number'
    ) {
      const envelope = parsed as PersistedEnvelope;
      if (!Number.isInteger(envelope.v) || envelope.v > options.version) return null;
      return options.validate(envelope.d);
    }
    // Legacy un-enveloped payload — keep migrating instead of dropping.
    return options.validate(parsed);
  } catch {
    return null;
  }
}

/**
 * Write a versioned envelope. Returns false and notifies subscribers when the
 * write fails (quota or any other error); never throws.
 */
export function writePersisted<T>(
  key: string,
  version: number,
  data: T,
  storage?: PersistedStorage,
): boolean {
  const target = storage ?? browserStorage();
  if (!target) return false;
  try {
    target.setItem(key, JSON.stringify({ v: version, d: data } satisfies PersistedEnvelope));
    return true;
  } catch (error) {
    notifyWriteFailure(key, isQuotaError(error) ? 'quota' : 'error');
    return false;
  }
}

/** Remove a persisted key. Never throws. */
export function removePersisted(key: string, storage?: PersistedStorage): void {
  const target = storage ?? browserStorage();
  if (!target) return;
  try {
    target.removeItem(key);
  } catch {
    // Best-effort cleanup only.
  }
}
