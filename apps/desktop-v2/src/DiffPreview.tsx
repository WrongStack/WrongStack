import { Columns2, MessageSquarePlus, Rows3 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { lineDiff } from './file-model';

export function DiffPreview({
  before,
  after,
  path,
  onComment,
}: {
  before: string;
  after: string;
  path: string;
  onComment?: (line: number) => void;
}) {
  const [split, setSplit] = useState(false),
    [all, setAll] = useState(false);
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
    <section className="file-diff-preview" aria-label={`Changes in ${path}`}>
      <div className="diff-preview-toolbar">
        <strong>{path.split('/').at(-1)}</strong>
        <span className="diff-added">+{added}</span>
        <span className="diff-removed">−{removed}</span>
        <button type="button" onClick={() => setAll(!all)}>
          {all ? 'Changes only' : 'Show entire file'}
        </button>
        <div className="file-mode-switch">
          <button
            type="button"
            aria-label="Unified diff"
            aria-pressed={!split}
            onClick={() => setSplit(false)}
          >
            <Rows3 size={14} />
          </button>
          <button
            type="button"
            aria-label="Side by side diff"
            aria-pressed={split}
            onClick={() => setSplit(true)}
          >
            <Columns2 size={14} />
          </button>
        </div>
      </div>
      {!added && !removed ? (
        <div className="file-quiet-state">This file matches HEAD.</div>
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
                  Show unchanged lines
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
                    aria-label={`Review line ${line.newLine ?? line.oldLine}`}
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
