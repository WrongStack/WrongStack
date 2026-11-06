import { FilePlus2, ListOrdered, Quote, X } from 'lucide-react';
import { useState } from 'react';
import {
  type ComposerFileReference,
  MAX_REFERENCE_LINE,
  referenceKey,
  referenceLabel,
  validReferenceLines,
} from './composer-resources-model';
import { useDesktopText } from './desktop-i18n';
import { displayLocale } from './display-dates';
import type { EngineCommand } from './engine-operations';

const PREVIEW_LINES = 40;

/** Attached project files, each with an optional line range and a bounded preview. */
export function ComposerReferenceChips({
  references,
  disabled,
  command,
  onChange,
}: {
  references: ComposerFileReference[];
  disabled: boolean;
  command: EngineCommand;
  onChange: (refs: ComposerFileReference[]) => Promise<boolean> | void;
}) {
  const { t } = useDesktopText();
  const [editing, setEditing] = useState<string | null>(null);
  if (!references.length) return null;
  const target = references.find((ref) => referenceKey(ref) === editing);
  const replace = (next: ComposerFileReference) =>
    references.flatMap((ref) =>
      referenceKey(ref) !== editing
        ? [ref]
        : // Editing into a reference that already exists keeps a single copy.
          references.some((other) => other !== ref && referenceKey(other) === referenceKey(next))
          ? []
          : [next],
    );
  return (
    <>
      <section className="composer-reference-chips" aria-label={t('referenceChips.label')}>
        {references.map((ref) => {
          const key = referenceKey(ref);
          return (
            <span key={key} title={referenceLabel(ref)}>
              <FilePlus2 size={12} />
              {referenceLabel(ref)}
              <button
                type="button"
                aria-label={
                  ref.snippet
                    ? t('referenceChips.showQuote', { ref: referenceLabel(ref) })
                    : t('referenceChips.setRange', { ref: referenceLabel(ref) })
                }
                aria-pressed={editing === key}
                disabled={disabled}
                onClick={() => setEditing(editing === key ? null : key)}
              >
                {ref.snippet ? <Quote size={11} /> : <ListOrdered size={11} />}
              </button>
              <button
                type="button"
                aria-label={t('referenceChips.remove', { ref: referenceLabel(ref) })}
                disabled={disabled}
                onClick={() => {
                  if (editing === key) setEditing(null);
                  void onChange(references.filter((item) => referenceKey(item) !== key));
                }}
              >
                <X size={11} />
              </button>
            </span>
          );
        })}
      </section>
      {target?.snippet && (
        <section
          className="composer-reference-range"
          aria-label={t('referenceChips.quoteFrom', { path: target.path })}
        >
          <figure
            className="composer-reference-preview"
            aria-label={t('referenceChips.quotedText')}
          >
            <pre>{target.snippet}</pre>
            <figcaption>
              {target.lines
                ? t('referenceChips.quotedFrom', {
                    chars: target.snippet.length.toLocaleString(displayLocale()),
                    ref: referenceLabel({ path: target.path, lines: target.lines }),
                  })
                : t('referenceChips.quotedUnsaved', {
                    chars: target.snippet.length.toLocaleString(displayLocale()),
                  })}
            </figcaption>
          </figure>
          <footer>
            <button
              type="button"
              className="button secondary small"
              onClick={() => setEditing(null)}
            >
              {t('referenceChips.close')}
            </button>
            <button
              type="button"
              className="button secondary small"
              disabled={disabled}
              onClick={() => {
                setEditing(null);
                void onChange(replace({ path: target.path }));
              }}
            >
              {t('referenceChips.wholeFileInstead')}
            </button>
          </footer>
        </section>
      )}
      {target && !target.snippet && (
        <ReferenceRangeEditor
          key={editing ?? target.path}
          reference={target}
          command={command}
          disabled={disabled}
          onCancel={() => setEditing(null)}
          onApply={(lines) => {
            setEditing(null);
            void onChange(replace(lines ? { path: target.path, lines } : { path: target.path }));
          }}
        />
      )}
    </>
  );
}

function ReferenceRangeEditor({
  reference,
  command,
  disabled,
  onCancel,
  onApply,
}: {
  reference: ComposerFileReference;
  command: EngineCommand;
  disabled: boolean;
  onCancel: () => void;
  onApply: (lines: [number, number] | null) => void;
}) {
  const { t } = useDesktopText();
  const [start, setStart] = useState(String(reference.lines?.[0] ?? ''));
  const [end, setEnd] = useState(String(reference.lines?.[1] ?? ''));
  const [preview, setPreview] = useState<{ lines: string[]; total: number } | null>(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const first = Number(start),
    last = Number(end || start);
  const lines: [number, number] = [first, last];
  const valid = start.trim() !== '' && validReferenceLines(lines);
  const load = async () => {
    if (!valid) return;
    setLoading(true);
    setMessage('');
    try {
      const file = await command('files.read', { filePath: reference.path }, ['files.read']);
      if (file['binary'] || file['tooLarge']) {
        setPreview(null);
        setMessage(t('referenceChips.noPreview'));
        return;
      }
      const all = String(file['content'] ?? '').split('\n');
      if (first > all.length) {
        setPreview(null);
        setMessage(t('referenceChips.pastEnd', { count: all.length }));
        return;
      }
      setPreview({
        lines: all.slice(first - 1, Math.min(last, first - 1 + PREVIEW_LINES)),
        total: all.length,
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };
  return (
    <section
      className="composer-reference-range"
      aria-label={t('referenceChips.rangeFor', { path: reference.path })}
    >
      <div className="composer-reference-range-fields">
        <label>
          {t('referenceChips.firstLine')}
          <input
            aria-label={t('referenceChips.firstLineLabel')}
            type="number"
            min={1}
            max={MAX_REFERENCE_LINE}
            value={start}
            disabled={disabled}
            onChange={(event) => {
              setStart(event.target.value);
              setPreview(null);
            }}
          />
        </label>
        <label>
          {t('referenceChips.lastLine')}
          <input
            aria-label={t('referenceChips.lastLineLabel')}
            type="number"
            min={1}
            max={MAX_REFERENCE_LINE}
            value={end}
            placeholder={start || undefined}
            disabled={disabled}
            onChange={(event) => {
              setEnd(event.target.value);
              setPreview(null);
            }}
          />
        </label>
        <button
          type="button"
          className="button secondary small"
          disabled={disabled || !valid || loading}
          onClick={() => void load()}
        >
          {loading ? t('referenceChips.reading') : t('referenceChips.preview')}
        </button>
      </div>
      {!valid && start.trim() !== '' && (
        <p className="field-help" role="alert">
          {t('referenceChips.invalid')}
        </p>
      )}
      {message && (
        <p className="field-help" role="status">
          {message}
        </p>
      )}
      {preview && (
        <figure
          className="composer-reference-preview"
          aria-label={t('referenceChips.previewLabel')}
        >
          <pre>
            {preview.lines.map((text, index) => (
              <span key={first + index}>
                <i>{first + index}</i>
                {text || ' '}
              </span>
            ))}
          </pre>
          {last - first + 1 > PREVIEW_LINES && (
            <figcaption>
              {t('referenceChips.showing', {
                shown: PREVIEW_LINES,
                range: last - first + 1,
                total: preview.total,
              })}
            </figcaption>
          )}
        </figure>
      )}
      <footer>
        <button type="button" className="button secondary small" onClick={onCancel}>
          {t('referenceChips.cancel')}
        </button>
        {reference.lines && (
          <button
            type="button"
            className="button secondary small"
            disabled={disabled}
            onClick={() => onApply(null)}
          >
            {t('referenceChips.wholeFile')}
          </button>
        )}
        <button
          type="button"
          className="button primary small"
          disabled={disabled || !valid}
          onClick={() => onApply(lines)}
        >
          {t('referenceChips.useLines', {
            lines: valid ? (first === last ? String(first) : `${first}-${last}`) : '',
          })}
        </button>
      </footer>
    </section>
  );
}
