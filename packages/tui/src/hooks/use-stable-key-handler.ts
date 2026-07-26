import { useCallback, useRef } from 'react';
import type { KeyEvent } from '../components/input.js';

type AppKeyHandler = (input: string, key: KeyEvent) => Promise<void>;

export function useStableKeyHandler(handleKey: AppKeyHandler): AppKeyHandler {
  const handleKeyRef = useRef<AppKeyHandler | null>(null);
  handleKeyRef.current = handleKey;

  return useCallback((input: string, key: KeyEvent) => {
    handleKeyRef.current?.(input, key)?.catch(() => {});
    return Promise.resolve();
  }, []);
}
