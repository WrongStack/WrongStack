import { useEffect, useMemo, useRef, useState } from 'react';
import type { EngineState } from './engine-state';
import { transcriptSearchText } from './transcript-window';
import { type ViewerFind, ViewerFindBar } from './ViewerFindBar';

/**
 * Ctrl+F in the conversation, as the WebUI's search overlay: matching messages are marked and
 * stepped through, earlier messages load when a match is among them. Returns the bar and how each
 * message is marked.
 */
export function useTranscriptFind({
  messages,
  enabled,
  reveal,
}: {
  messages: EngineState['messages'];
  /** The chat view is showing; Ctrl+F belongs to other views otherwise. */
  enabled: boolean;
  /** Brings message `index` (0-based) into view. */
  reveal: (index: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState<ViewerFind>({ lines: [], current: 0 });
  const content = useMemo(() => (open ? transcriptSearchText(messages) : ''), [open, messages]);
  const show = useRef(reveal);
  show.current = reveal;
  useEffect(() => {
    if (!enabled) return;
    const key = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return;
      if (document.querySelector('dialog[open]')) return;
      event.preventDefault();
      setOpen(true);
      // Pressing it again with the bar open moves back to its field.
      document.querySelector<HTMLInputElement>('input[aria-label="Find in conversation"]')?.focus();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [enabled]);
  useEffect(() => {
    if (find.current) show.current(find.current - 1);
  }, [find.current]);
  const matched = new Set(find.lines.map((line) => messages[line - 1]?.id));
  const current = find.current ? messages[find.current - 1]?.id : undefined;
  return {
    bar:
      open && enabled ? (
        <ViewerFindBar
          content={content}
          scope="conversation"
          onChange={setFind}
          onClose={() => {
            setOpen(false);
            setFind({ lines: [], current: 0 });
          }}
        />
      ) : null,
    mark: (id: string): 'current' | 'match' | undefined =>
      id === current ? 'current' : matched.has(id) ? 'match' : undefined,
  };
}
