import { FilePlus2, ListOrdered, Quote, X } from 'lucide-react';
import { useState } from 'react';
import {
  type ComposerFileReference,
  MAX_REFERENCE_LINE,
  referenceKey,
  referenceLabel,
  validReferenceLines,
} from './composer-resources-model';
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
      <section className="composer-reference-chips" aria-label="Attached project files">
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
                    ? `Show quoted text from ${referenceLabel(ref)}`
                    : `Set line range for ${referenceLabel(ref)}`
                }
                aria-pressed={editing === key}
                disabled={disabled}
                onClick={() => setEditing(editing === key ? null : key)}
              >
                {ref.snippet ? <Quote size={11} /> : <ListOrdered size={11} />}
              </button>
              <button
                type="button"
                aria-label={`Remove file reference ${referenceLabel(ref)}`}
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
        <section className="composer-reference-range" aria-label={`Quote from ${target.path}`}>
          <figure className="composer-reference-preview" aria-label="Quoted text">
            <pre>{target.snippet}</pre>
            <figcaption>
              {target.snippet.length.toLocaleString()} characters quoted
              {target.lines
                ? ` from ${referenceLabel({ path: target.path, lines: target.lines })}`
                : ' (line numbers not attached: the text was unsaved)'}
              . The quote is sent as selected; the file on disk may differ.
            </figcaption>
          </figure>
          <footer>
            <button
              type="button"
              className="button secondary small"
              onClick={() => setEditing(null)}
            >
              Close
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
              Reference whole file instead
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
        setMessage('No text preview is available for this file. The range can still be attached.');
        return;
      }
      const all = String(file['content'] ?? '').split('\n');
      if (first > all.length) {
        setPreview(null);
        setMessage(`This file has ${all.length} lines; the range starts after its end.`);
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
    <section className="composer-reference-range" aria-label={`Line range for ${reference.path}`}>
      <div className="composer-reference-range-fields">
        <label>
          First line
          <input
            aria-label="First referenced line"
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
          Last line
          <input
            aria-label="Last referenced line"
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
          {loading ? 'Reading…' : 'Preview lines'}
        </button>
      </div>
      {!valid && start.trim() !== '' && (
        <p className="field-help" role="alert">
          Use whole line numbers from 1, with the last line not before the first.
        </p>
      )}
      {message && (
        <p className="field-help" role="status">
          {message}
        </p>
      )}
      {preview && (
        <figure className="composer-reference-preview" aria-label="Referenced lines preview">
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
              Showing the first {PREVIEW_LINES} of {last - first + 1} referenced lines · file has{' '}
              {preview.total} lines.
            </figcaption>
          )}
        </figure>
      )}
      <footer>
        <button type="button" className="button secondary small" onClick={onCancel}>
          Cancel
        </button>
        {reference.lines && (
          <button
            type="button"
            className="button secondary small"
            disabled={disabled}
            onClick={() => onApply(null)}
          >
            Reference whole file
          </button>
        )}
        <button
          type="button"
          className="button primary small"
          disabled={disabled || !valid}
          onClick={() => onApply(lines)}
        >
          Use lines {valid ? (first === last ? first : `${first}-${last}`) : ''}
        </button>
      </footer>
    </section>
  );
}
