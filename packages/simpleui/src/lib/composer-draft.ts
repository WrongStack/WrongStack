import {
  type PersistedStorage,
  readPersisted,
  removePersisted,
  writePersisted,
} from './persisted.js';

export interface ComposerDraft {
  text: string;
  fileRefs: string[];
}

export interface DraftStorage extends PersistedStorage {}

const DRAFT_PREFIX = 'wrongstack.simpleui.draft.';
const DRAFT_SCHEMA_VERSION = 1;
const MAX_DRAFT_CHARS = 20_000;
const MAX_FILE_REFS = 20;
const MAX_PATH_CHARS = 500;
/** Drafts for sessions untouched for this long are pruned at startup. */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredDraft extends ComposerDraft {
  savedAt: number;
}

function emptyDraft(): ComposerDraft {
  return { text: '', fileRefs: [] };
}

function browserStorage(): DraftStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function draftKey(sessionId: string): string {
  return `${DRAFT_PREFIX}${encodeURIComponent(sessionId)}`;
}

function normalizeDraft(value: unknown): ComposerDraft {
  if (!value || typeof value !== 'object') return emptyDraft();
  const item = value as Record<string, unknown>;
  const text = typeof item['text'] === 'string' ? item['text'].slice(0, MAX_DRAFT_CHARS) : '';
  const fileRefs = Array.isArray(item['fileRefs'])
    ? [
        ...new Set(
          item['fileRefs']
            .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
            .map((entry) => entry.slice(0, MAX_PATH_CHARS)),
        ),
      ].slice(0, MAX_FILE_REFS)
    : [];
  return { text, fileRefs };
}

export function readComposerDraft(
  sessionId: string,
  storage: DraftStorage | undefined = browserStorage(),
): ComposerDraft {
  if (!sessionId) return emptyDraft();
  const stored = readPersisted<StoredDraft>(draftKey(sessionId), {
    version: DRAFT_SCHEMA_VERSION,
    storage,
    validate: (value) => {
      if (!value || typeof value !== 'object') return null;
      return value as StoredDraft;
    },
  });
  if (!stored) return emptyDraft();
  // `savedAt` is housekeeping for the startup prune; callers see the draft shape.
  return normalizeDraft(stored);
}

export function writeComposerDraft(
  sessionId: string,
  draft: ComposerDraft,
  storage: DraftStorage | undefined = browserStorage(),
): boolean {
  if (!sessionId) return false;
  const normalized = normalizeDraft(draft);
  if (!normalized.text && normalized.fileRefs.length === 0) {
    removePersisted(draftKey(sessionId), storage);
    return true;
  }
  const stored: StoredDraft = { ...normalized, savedAt: Date.now() };
  return writePersisted(draftKey(sessionId), DRAFT_SCHEMA_VERSION, stored, storage);
}

export function clearComposerDraft(
  sessionId: string,
  storage: DraftStorage | undefined = browserStorage(),
): void {
  if (!sessionId) return;
  removePersisted(draftKey(sessionId), storage);
}

/**
 * Drop drafts whose `savedAt` is older than `maxAgeMs`. Called once at app
 * startup so abandoned sessions cannot accumulate draft keys forever. Legacy
 * drafts without a timestamp are kept (their age is unknowable) and gain a
 * timestamp the next time they are written.
 */
export function pruneStaleComposerDrafts(
  maxAgeMs: number = DRAFT_MAX_AGE_MS,
  storage: DraftStorage | undefined = browserStorage(),
): void {
  if (!storage) return;
  const cutoff = Date.now() - maxAgeMs;
  // Real `Storage` exposes key(i)/length; the test memory-mock does not, so
  // fall back to own enumerable keys.
  const indexed = storage as PersistedStorage & {
    length?: number;
    key?: (index: number) => string | null;
  };
  let keys: string[] = [];
  try {
    if (typeof indexed.key === 'function' && typeof indexed.length === 'number') {
      keys = [];
      for (let i = 0; i < indexed.length; i++) {
        const key = indexed.key(i);
        if (key) keys.push(key);
      }
    } else {
      keys = Object.keys(storage);
    }
  } catch {
    return;
  }
  for (const key of keys) {
    if (!key.startsWith(DRAFT_PREFIX)) continue;
    try {
      const raw = storage.getItem(key);
      if (!raw) continue;
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === 'object' &&
        'd' in parsed &&
        (parsed as { d: unknown }).d &&
        typeof (parsed.d as Record<string, unknown>).savedAt === 'number' &&
        (parsed.d as { savedAt: number }).savedAt < cutoff
      ) {
        storage.removeItem(key);
      }
    } catch {
      // Corrupt entries are left alone; pruning must never throw.
    }
  }
}
