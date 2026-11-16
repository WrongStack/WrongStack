import { useCallback, useEffect, useRef } from 'react';
import type { KeyEvent } from '../components/input.js';

type AppKeyHandler = (input: string, key: KeyEvent) => Promise<void>;

/**
 * Returns an identity-stable key handler that always calls the latest
 * `handleKey`. A rejected key handler must never kill the process, but it
 * must not vanish either: `onError` receives the failure so the host can
 * surface it (an error entry in the transcript). Without `onError` the
 * failure is still contained.
 */
export function useStableKeyHandler(
  handleKey: AppKeyHandler,
  onError?: (err: unknown) => void,
): AppKeyHandler {
  const handleKeyRef = useRef<AppKeyHandler | null>(null);
  handleKeyRef.current = handleKey;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const tailRef = useRef<Promise<void> | undefined>(undefined);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return useCallback((input: string, key: KeyEvent) => {
    const invoke = (): Promise<void> => {
      if (!mountedRef.current) return Promise.resolve();
      try {
        return Promise.resolve(handleKeyRef.current?.(input, key)).catch((err: unknown) =>
          reportKeyError(onErrorRef.current, err),
        );
      } catch (err) {
        reportKeyError(onErrorRef.current, err);
        return Promise.resolve();
      }
    };
    // Preserve edit/paste/submit order across asynchronous route boundaries.
    // Agent runs remain detached by the submit route; interrupts and pointer
    // controls must stay responsive even if a clipboard/attachment operation stalls.
    const interrupt =
      key.escape ||
      key.mouse !== undefined ||
      (key.ctrl && (input === 'c' || input === 'C' || input === '\x03'));
    const work = !interrupt && tailRef.current ? tailRef.current.then(invoke) : invoke();
    if (!interrupt) {
      tailRef.current = work;
      void work.then(() => {
        if (tailRef.current === work) tailRef.current = undefined;
      });
    }
    return Promise.resolve();
  }, []);
}

function reportKeyError(onError: ((err: unknown) => void) | undefined, err: unknown): void {
  try {
    onError?.(err);
  } catch {
    // The reporter itself failed; containment wins over reporting.
  }
}
