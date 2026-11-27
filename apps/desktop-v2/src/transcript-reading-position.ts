import { type RefObject, useCallback, useLayoutEffect, useRef } from 'react';
import type { ChatMessage } from './engine-state';
import type { TranscriptHandle } from './TranscriptVirtualizer';

export interface TranscriptReadingPosition {
  messageId: string;
  offset: number;
}

const STORAGE_KEY = 'wrongstack.desktop.transcript-reading.v1';
const POSITION_LIMIT = 128;
const SAVE_INTERVAL_MS = 160;
let recent = new Map<string, TranscriptReadingPosition>();
let storageUnavailable = false;

function readPositions(): Map<string, TranscriptReadingPosition> {
  if (storageUnavailable) return recent;
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(raw)) return recent;
    const positions = new Map<string, TranscriptReadingPosition>();
    for (const entry of raw.slice(-POSITION_LIMIT)) {
      if (!Array.isArray(entry)) continue;
      const [key, position] = entry;
      if (
        typeof key === 'string' &&
        typeof position?.messageId === 'string' &&
        Number.isFinite(position.offset)
      ) {
        positions.set(key, position);
      }
    }
    return positions;
  } catch {
    return recent;
  }
}

function savePosition(key: string, position: TranscriptReadingPosition | null) {
  const positions = readPositions();
  if (position === null && !positions.has(key)) return;
  const previous = positions.get(key);
  if (position && previous?.messageId === position.messageId && previous.offset === position.offset)
    return;
  positions.delete(key);
  if (position) positions.set(key, position);
  if (positions.size > POSITION_LIMIT) positions.delete(positions.keys().next().value!);
  recent = positions;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...positions]));
  } catch {
    // Keep revisit restoration in memory if browser storage is unavailable.
    storageUnavailable = true;
  }
}

/** Persist only a paused reader's message and pixel offset. No synchronous storage on scroll. */
export function useTranscriptReadingPosition({
  key,
  ready,
  messages,
  transcript,
  pause,
  reset,
}: {
  key: string;
  ready: boolean;
  messages: readonly ChatMessage[];
  transcript: RefObject<TranscriptHandle | null>;
  pause: () => void;
  reset: () => void;
}) {
  const restored = useRef('');
  const pending = useRef<{ key: string; position: TranscriptReadingPosition | null } | undefined>(
    undefined,
  );
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const entry = pending.current;
    pending.current = undefined;
    if (entry) savePosition(entry.key, entry.position);
  }, []);
  useLayoutEffect(() => {
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [flush]);
  useLayoutEffect(() => {
    if (!ready || !key || restored.current === key) return;
    flush();
    restored.current = key;
    const saved = readPositions().get(key);
    const index = saved ? messages.findIndex(({ id }) => id === saved.messageId) : -1;
    if (saved && index >= 0) {
      pause();
      transcript.current?.scrollToMessage(index, saved.offset);
    } else {
      reset();
    }
  }, [key, ready, messages, transcript, pause, reset, flush]);
  return {
    capture() {
      if (!ready || !key || restored.current !== key) return;
      const position = transcript.current?.readingPosition();
      if (!position) return;
      pending.current = { key, position };
      timer.current ??= setTimeout(flush, SAVE_INTERVAL_MS);
    },
    forget() {
      if (!key) return;
      if (pending.current && pending.current.key !== key) flush();
      pending.current = { key, position: null };
      flush();
    },
  };
}
