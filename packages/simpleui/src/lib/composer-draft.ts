export interface ComposerDraft {
  text: string;
  fileRefs: string[];
}

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const DRAFT_PREFIX = 'wrongstack.simpleui.draft.';
const MAX_DRAFT_CHARS = 20_000;
const MAX_FILE_REFS = 20;
const MAX_PATH_CHARS = 500;

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
  if (!sessionId || !storage) return emptyDraft();
  try {
    const raw = storage.getItem(draftKey(sessionId));
    return raw ? normalizeDraft(JSON.parse(raw)) : emptyDraft();
  } catch {
    return emptyDraft();
  }
}

export function writeComposerDraft(
  sessionId: string,
  draft: ComposerDraft,
  storage: DraftStorage | undefined = browserStorage(),
): void {
  if (!sessionId || !storage) return;
  try {
    const normalized = normalizeDraft(draft);
    if (!normalized.text && normalized.fileRefs.length === 0) {
      storage.removeItem(draftKey(sessionId));
      return;
    }
    storage.setItem(draftKey(sessionId), JSON.stringify(normalized));
  } catch {
    // Draft persistence is best-effort in privacy-restricted browsers.
  }
}

export function clearComposerDraft(
  sessionId: string,
  storage: DraftStorage | undefined = browserStorage(),
): void {
  if (!sessionId || !storage) return;
  try {
    storage.removeItem(draftKey(sessionId));
  } catch {
    // Best-effort cleanup only.
  }
}
