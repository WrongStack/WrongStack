import { Code2, Undo2, X } from 'lucide-react';
import { type ClipboardEvent, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { fencePaste, insideFence, pastedCode, pastedText } from './paste-code';

type Hint =
  | { kind: 'offer'; start: number; text: string; language: string }
  | { kind: 'wrapped'; before: string; after: string; cursor: number };

/**
 * Offers to fence pasted source code. Nothing changes until the user chooses; the offer
 * disappears once the pasted text is edited, and a wrap can be undone while the draft is
 * still exactly the wrapped result.
 */
export function usePasteHint(draft: string, replace: (text: string, cursor: number) => void) {
  const { t } = useDesktopText();
  const [hint, setHint] = useState<Hint | null>(null);
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    // A textarea stores pasted line breaks as LF; Windows clipboards supply CRLF.
    const text = pastedText(event.clipboardData.getData('text/plain'));
    const start = Math.min(event.currentTarget.selectionStart, event.currentTarget.selectionEnd);
    const code = text && !insideFence(draft, start) ? pastedCode(text) : null;
    setHint(code ? { kind: 'offer', start, text, language: code.language } : null);
  };
  const live =
    hint?.kind === 'offer'
      ? draft.slice(hint.start, hint.start + hint.text.length) === hint.text
      : hint?.kind === 'wrapped' && draft === hint.after;
  const element =
    hint && live ? (
      <div className="composer-paste-hint" role="status">
        {hint.kind === 'offer' ? (
          <>
            <span>
              {hint.language
                ? t('pasteHint.looksLikeLanguage', { language: hint.language })
                : t('pasteHint.looksLike')}
            </span>
            <button
              type="button"
              className="button secondary small"
              onClick={() => {
                const next = fencePaste(draft, hint.start, hint.text, hint.language);
                replace(next.text, next.cursor);
                setHint({
                  kind: 'wrapped',
                  before: draft,
                  after: next.text,
                  cursor: hint.start + hint.text.length,
                });
              }}
            >
              <Code2 size={13} />
              {t('pasteHint.wrap')}
            </button>
          </>
        ) : (
          <>
            <span>{t('pasteHint.wrapped')}</span>
            <button
              type="button"
              className="button secondary small"
              onClick={() => {
                replace(hint.before, hint.cursor);
                setHint(null);
              }}
            >
              <Undo2 size={13} />
              {t('pasteHint.undo')}
            </button>
          </>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label={t('pasteHint.dismiss')}
          onClick={() => setHint(null)}
        >
          <X size={13} />
        </button>
      </div>
    ) : null;
  return { onPaste, element };
}
