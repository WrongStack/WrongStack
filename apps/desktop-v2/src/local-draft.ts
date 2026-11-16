import { startTransition, useCallback, useRef, useState } from 'react';

/**
 * Keeps the composer's text local so a keystroke repaints only the composer. The saved draft
 * lives in the window controller, and updating it re-renders the whole window (sidebar,
 * conversation, side panels); that update now runs as a transition, which React interrupts
 * for the next keystroke instead of making typing wait for it.
 *
 * A saved value this composer did not write (cleared after sending, recalled, restored after a
 * conflict, inserted by another view) replaces the local text. A saved value it wrote itself
 * can arrive after newer keystrokes; it is recognised and never rolls the text back.
 */
export function useLocalDraft(
  saved: string,
  save: (text: string) => Promise<boolean>,
): [text: string, change: (text: string) => Promise<boolean>] {
  const [text, setText] = useState(saved);
  const seen = useRef(saved);
  // Values written from here that the controller has not shown back yet, oldest first.
  const written = useRef<string[]>([]);
  if (saved !== seen.current) {
    seen.current = saved;
    const at = written.current.indexOf(saved);
    if (at >= 0) written.current = written.current.slice(at + 1);
    else {
      written.current = [];
      if (saved !== text) setText(saved);
    }
  }
  // In step again: nothing written here is still on its way, so an older echo cannot be
  // mistaken for a later value from elsewhere.
  if (saved === text) written.current = [];
  const latest = useRef(save);
  latest.current = save;
  const change = useCallback((next: string) => {
    setText(next);
    written.current.push(next);
    if (written.current.length > 256) written.current.shift();
    let result: Promise<boolean> = Promise.resolve(true);
    startTransition(() => {
      result = latest.current(next);
    });
    return result;
  }, []);
  return [text, change];
}
