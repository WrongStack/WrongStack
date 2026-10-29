import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { findMatches, MAX_MATCHES, matchLines } from './editor-find';

export interface ViewerFind {
  /** Lines containing a match. */
  lines: number[];
  /** The line moved to with Enter or the arrows, or 0 before the first move. */
  current: number;
}

/**
 * Find for the read-only source view: matching lines are marked and stepped through. Nothing is
 * replaced here; editing the file offers find and replace.
 */
export function ViewerFindBar({
  content,
  onChange,
  onClose,
}: {
  content: string;
  onChange: (find: ViewerFind) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(''),
    [caseSensitive, setCaseSensitive] = useState(false),
    [index, setIndex] = useState(-1);
  const matches = useMemo(
    () => findMatches(content, query, caseSensitive),
    [content, query, caseSensitive],
  );
  const lines = useMemo(() => matchLines(content, matches), [content, matches]);
  useEffect(() => {
    onChange({ lines, current: index >= 0 ? (lines[index] ?? 0) : 0 });
  }, [lines, index, onChange]);
  const go = (direction: 1 | -1) => {
    if (!lines.length) return;
    setIndex((current) =>
      current < 0
        ? direction === 1
          ? 0
          : lines.length - 1
        : (current + direction + lines.length) % lines.length,
    );
  };
  const count =
    matches.length >= MAX_MATCHES ? `${MAX_MATCHES.toLocaleString()}+` : String(matches.length);
  return (
    <section className="editor-find-bar" aria-label="Find in read-only source">
      <input
        aria-label="Find in source"
        placeholder="Find"
        value={query}
        // biome-ignore lint/a11y/noAutofocus: the bar opens on an explicit Find request.
        autoFocus
        onChange={(event) => {
          setQuery(event.target.value);
          setIndex(-1);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            go(event.shiftKey ? -1 : 1);
          } else if (event.key === 'Escape') onClose();
        }}
      />
      <span role="status" className="editor-find-count">
        {query
          ? `${count} matches on ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}${index >= 0 ? ` · line ${lines[index]}` : ''}`
          : ''}
      </span>
      <button
        type="button"
        className="icon-button"
        aria-label="Previous matching line"
        onClick={() => go(-1)}
      >
        <ChevronUp size={13} />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label="Next matching line"
        onClick={() => go(1)}
      >
        <ChevronDown size={13} />
      </button>
      <label>
        <input
          type="checkbox"
          checked={caseSensitive}
          onChange={(event) => {
            setCaseSensitive(event.target.checked);
            setIndex(-1);
          }}
        />{' '}
        Match case
      </label>
      <button type="button" className="icon-button" aria-label="Close find" onClick={onClose}>
        <X size={13} />
      </button>
    </section>
  );
}
