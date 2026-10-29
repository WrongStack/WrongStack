import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { findMatches, MAX_MATCHES, nextMatchIndex, replaceAllMatches } from './editor-find';

/**
 * Find and replace for the open file editor. Replacing changes the editor text only; Save
 * still writes the file. A replace-all can be undone while the text is unchanged since.
 */
export function EditorFindBar({
  content,
  editor,
  onChange,
  onClose,
}: {
  content: string;
  editor: () => HTMLTextAreaElement | null;
  onChange: (content: string, select?: { start: number; end: number }) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(''),
    [replacement, setReplacement] = useState(''),
    [caseSensitive, setCaseSensitive] = useState(false),
    [current, setCurrent] = useState(-1),
    [undo, setUndo] = useState<{ before: string; after: string; count: number } | null>(null),
    [message, setMessage] = useState('');
  const matches = useMemo(
    () => findMatches(content, query, caseSensitive),
    [content, query, caseSensitive],
  );
  const select = (index: number) => {
    const match = matches[index];
    const input = editor();
    if (!match || !input) return;
    setCurrent(index);
    input.focus();
    input.setSelectionRange(match.start, match.end);
  };
  const go = (direction: 1 | -1) => {
    const input = editor();
    const caret = input ? (direction === 1 ? input.selectionEnd : input.selectionStart) : 0;
    select(nextMatchIndex(matches, caret, direction));
  };
  const replaceCurrent = () => {
    const input = editor();
    const match = matches.find(
      (item) => input && item.start === input.selectionStart && item.end === input.selectionEnd,
    );
    if (!match) {
      go(1);
      return;
    }
    const next = content.slice(0, match.start) + replacement + content.slice(match.end);
    const caret = match.start + replacement.length;
    onChange(next, { start: caret, end: caret });
    setUndo(null);
    setMessage('Replaced 1 match.');
  };
  const replaceAll = () => {
    const result = replaceAllMatches(content, query, replacement, caseSensitive);
    if (!result.count) {
      setMessage(
        matches.length >= MAX_MATCHES
          ? `More than ${MAX_MATCHES.toLocaleString()} matches; narrow the search before replacing all.`
          : 'No matches to replace.',
      );
      return;
    }
    onChange(result.text);
    setUndo({ before: content, after: result.text, count: result.count });
    setMessage(`Replaced ${result.count} ${result.count === 1 ? 'match' : 'matches'}.`);
  };
  const count =
    matches.length >= MAX_MATCHES ? `${MAX_MATCHES.toLocaleString()}+` : String(matches.length);
  return (
    <section className="editor-find-bar" aria-label="Find and replace">
      <input
        aria-label="Find in file"
        placeholder="Find"
        value={query}
        // biome-ignore lint/a11y/noAutofocus: the bar opens on an explicit Find request.
        autoFocus
        onChange={(event) => {
          setQuery(event.target.value);
          setCurrent(-1);
          setMessage('');
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            go(event.shiftKey ? -1 : 1);
          } else if (event.key === 'Escape') onClose();
        }}
      />
      <span role="status" className="editor-find-count">
        {query ? (current >= 0 ? `${current + 1} of ${count}` : `${count} matches`) : ''}
      </span>
      <button
        type="button"
        className="icon-button"
        aria-label="Previous match"
        onClick={() => go(-1)}
      >
        <ChevronUp size={13} />
      </button>
      <button type="button" className="icon-button" aria-label="Next match" onClick={() => go(1)}>
        <ChevronDown size={13} />
      </button>
      <label>
        <input
          type="checkbox"
          checked={caseSensitive}
          onChange={(event) => setCaseSensitive(event.target.checked)}
        />{' '}
        Match case
      </label>
      <input
        aria-label="Replace with"
        placeholder="Replace"
        value={replacement}
        onChange={(event) => setReplacement(event.target.value)}
      />
      <button
        type="button"
        className="button secondary small"
        disabled={!matches.length}
        onClick={replaceCurrent}
      >
        Replace
      </button>
      <button
        type="button"
        className="button secondary small"
        disabled={!matches.length}
        onClick={replaceAll}
      >
        Replace all
      </button>
      {undo && content === undo.after && (
        <button
          type="button"
          className="button secondary small"
          onClick={() => {
            onChange(undo.before);
            setUndo(null);
            setMessage(`Restored the text before replacing ${undo.count} matches.`);
          }}
        >
          Undo replace all
        </button>
      )}
      {message && <small className="field-help">{message}</small>}
      <button type="button" className="icon-button" aria-label="Close find" onClick={onClose}>
        <X size={13} />
      </button>
    </section>
  );
}
