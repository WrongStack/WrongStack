import { useEffect, useState } from 'react';

const LIMIT = 100;
export function readMessagePins(storage: Pick<Storage, 'getItem'>, key: string): string[] {
  const value: unknown = JSON.parse(storage.getItem(key) ?? '[]');
  return Array.isArray(value)
    ? [
        ...new Set(
          value.filter(
            (id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 500,
          ),
        ),
      ].slice(0, LIMIT)
    : [];
}
export function toggleMessagePin(ids: readonly string[], id: string): string[] {
  if (ids.includes(id)) return ids.filter((value) => value !== id);
  if (ids.length >= LIMIT) throw Error('At most 100 messages can be pinned in one conversation.');
  return [...ids, id];
}
/** Pins belong to one native project/conversation and survive a window reload. */
export function useMessagePins(scope: string, onError: (error: unknown) => void) {
  const key = `wrongstack.desktop.message-pins:${scope}`;
  const [ids, setIds] = useState<string[]>(() => {
    try {
      return readMessagePins(localStorage, key);
    } catch {
      return [];
    }
  });
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === key || event.key === null) {
        try {
          setIds(readMessagePins(localStorage, key));
        } catch (error) {
          onError(error);
        }
      }
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [key, onError]);
  return {
    ids,
    toggle: (id: string) => {
      try {
        const next = toggleMessagePin(readMessagePins(localStorage, key), id);
        localStorage.setItem(key, JSON.stringify(next));
        setIds(next);
      } catch (error) {
        onError(error);
      }
    },
  };
}
