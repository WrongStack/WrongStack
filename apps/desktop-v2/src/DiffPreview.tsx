import { Columns2, FilePenLine, MessageSquarePlus, Rows3 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { DiffEditorSlot } from './CodeEditorSlot';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { lineDiff } from './file-model';

export function DiffPreview({
  before,
  after,
  path,
  onComment,
  edit,
}: {
  before: string;
  after: string;
  path: string;
  onComment?: (line: number) => void;
  /** Offers the editable side-by-side diff, which applies the working-tree side to the file. */
  edit?: { command: EngineCommand; onApplied: () => void } | undefined;
}) {
  const { t } = useDesktopText();
  const [split, setSplit] = useState(false),
    [all, setAll] = useState(false),
    [editing, setEditing] = useState(false);
  const lines = useMemo(() => lineDiff(before, after), [before, after]);
  const keep = useMemo(() => {
    const indexes = new Set<number>();
    lines.forEach((line, index) => {
      if (line.kind !== 'same')
        for (let j = Math.max(0, index - 3); j <= Math.min(lines.length - 1, index + 3); j++)
          indexes.add(j);
    });
    return indexes;
  }, [lines]);
  const added = lines.filter((l) => l.kind === 'add').length,
    removed = lines.filter((l) => l.kind === 'remove').length;
  return (
    <section className="file-diff-preview" aria-label={t('diff.label', { path })}>
      <div className="diff-preview-toolbar">
        <strong>{path.split('/').at(-1)}</strong>
        <span className="diff-added">+{added}</span>
        <span className="diff-removed">−{removed}</span>
        <button type="button" onClick={() => setAll(!all)}>
          {all ? t('diff.changesOnly') : t('diff.wholeFile')}
        </button>
        <div className="file-mode-switch">
          <button
            type="button"
            aria-label={t('diff.unified')}
            aria-pressed={!split && !editing}
            onClick={() => {
              setSplit(false);
              setEditing(false);
            }}
          >
            <Rows3 size={14} />
          </button>
          <button
            type="button"
            aria-label={t('diff.split')}
            aria-pressed={split && !editing}
            onClick={() => {
              setSplit(true);
              setEditing(false);
            }}
          >
            <Columns2 size={14} />
          </button>
          {edit && (
            <button
              type="button"
              aria-label={t('diff.edit')}
              title={t('diff.edit')}
              aria-pressed={editing}
              onClick={() => setEditing(true)}
            >
              <FilePenLine size={14} />
            </button>
          )}
        </div>
      </div>
      {editing && edit ? (
        <DiffEditorSlot
          path={path}
          before={before}
          after={after}
          command={edit.command}
          onApplied={edit.onApplied}
          loading={t('diff.editLoading')}
          onUnavailable={() => setEditing(false)}
        />
      ) : !added && !removed ? (
        <div className="file-quiet-state">{t('diff.matchesHead')}</div>
      ) : (
        <div className={`diff-code-lines ${split ? 'diff-split' : ''}`}>
          {lines.map((line, index) => {
            if (!all && !keep.has(index))
              return index === 0 || keep.has(index - 1) ? (
                <button
                  type="button"
                  key={`gap-${index}`}
                  className="diff-gap"
                  onClick={() => setAll(true)}
                >
                  {t('diff.unchanged')}
                </button>
              ) : null;
            return (
              <div className={`diff-code-line diff-line-${line.kind}`} key={index}>
                <span className="diff-line-number">{line.oldLine ?? ''}</span>
                <span className="diff-line-number">{line.newLine ?? ''}</span>
                <span className="diff-sign">
                  {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
                </span>
                {split ? (
                  <>
                    <code
                      className={`diff-old-cell ${line.kind === 'add' ? 'diff-empty-cell' : ''}`}
                    >
                      {line.kind === 'add' ? '' : line.text || ' '}
                    </code>
                    <code
                      className={`diff-new-cell ${line.kind === 'remove' ? 'diff-empty-cell' : ''}`}
                    >
                      {line.kind === 'remove' ? '' : line.text || ' '}
                    </code>
                  </>
                ) : (
                  <code>{line.text || ' '}</code>
                )}
                {onComment && (
                  <button
                    type="button"
                    className="diff-line-comment"
                    aria-label={t('diff.review', { line: line.newLine ?? line.oldLine })}
                    onClick={() => onComment(line.newLine ?? line.oldLine ?? 1)}
                  >
                    <MessageSquarePlus size={13} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// The Changes view's other preview: an image's two versions, or why a binary file has no review.
export { BinaryChange } from './BinaryChange';
