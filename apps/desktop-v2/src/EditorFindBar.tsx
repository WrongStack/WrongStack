import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
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
  const { t } = useDesktopText();
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
    setMessage(t('find.replacedOne'));
  };
  const replaceAll = () => {
    const result = replaceAllMatches(content, query, replacement, caseSensitive);
    if (!result.count) {
      setMessage(
        matches.length >= MAX_MATCHES
          ? t('find.tooMany', { max: MAX_MATCHES.toLocaleString() })
          : t('find.none'),
      );
      return;
    }
    onChange(result.text);
    setUndo({ before: content, after: result.text, count: result.count });
    setMessage(
      result.count === 1 ? t('find.replacedOne') : t('find.replacedMany', { count: result.count }),
    );
  };
  const count =
    // A number picks the singular ("1 match"); the capped count reads as text.
    matches.length >= MAX_MATCHES ? `${MAX_MATCHES.toLocaleString()}+` : matches.length;
  return (
    <section className="editor-find-bar" aria-label={t('find.replaceLabel')}>
      <input
        aria-label={t('find.inFile')}
        placeholder={t('find.placeholder')}
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
        {query
          ? current >= 0
            ? t('find.position', { current: current + 1, count })
            : t('find.matches', { count })
          : ''}
      </span>
      <button
        type="button"
        className="icon-button"
        aria-label={t('find.previous')}
        onClick={() => go(-1)}
      >
        <ChevronUp size={13} />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={t('find.next')}
        onClick={() => go(1)}
      >
        <ChevronDown size={13} />
      </button>
      <label>
        <input
          type="checkbox"
          checked={caseSensitive}
          onChange={(event) => setCaseSensitive(event.target.checked)}
        />{' '}
        {t('find.matchCase')}
      </label>
      <input
        aria-label={t('find.replaceWith')}
        placeholder={t('find.replacePlaceholder')}
        value={replacement}
        onChange={(event) => setReplacement(event.target.value)}
      />
      <button
        type="button"
        className="button secondary small"
        disabled={!matches.length}
        onClick={replaceCurrent}
      >
        {t('find.replace')}
      </button>
      <button
        type="button"
        className="button secondary small"
        disabled={!matches.length}
        onClick={replaceAll}
      >
        {t('find.replaceAll')}
      </button>
      {undo && content === undo.after && (
        <button
          type="button"
          className="button secondary small"
          onClick={() => {
            onChange(undo.before);
            setUndo(null);
            setMessage(t('find.restored', { count: undo.count }));
          }}
        >
          {t('find.undo')}
        </button>
      )}
      {message && <small className="field-help">{message}</small>}
      <button type="button" className="icon-button" aria-label={t('find.close')} onClick={onClose}>
        <X size={13} />
      </button>
    </section>
  );
}
