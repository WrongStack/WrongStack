import type {
  GitHubActionResult,
  GitHubLineComment,
  GitHubPullFile,
} from '@wrongstack/webui-protocol';
import { MessageSquarePlus, X } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { anchorKey, numberPatch, rowAnchor } from './github-view-model';
import { usePendingReview } from './pending-review';

type Anchor = { line: number; side: 'LEFT' | 'RIGHT' };

function CommentList({ comments }: { comments: GitHubLineComment[] }) {
  const { t } = useAppTranslation();
  return (
    <ul className="space-y-1 border-y border-border/60 bg-muted/30 px-3 py-2 font-sans">
      {comments.map((comment, index) => (
        <li key={`${comment.createdAt}:${index}`} className="text-xs">
          <span className="font-medium">
            {comment.author ?? t('activity:github.unknownAuthor')}
          </span>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">
            {comment.body}
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * One file's GitHub patch with real line numbers. Each line can take a review
 * comment, and the comments already on a line show under it; comments whose
 * line left the diff are listed after the patch.
 */
export function PatchView({
  file,
  comments,
  canComment,
  onComment,
}: {
  file: GitHubPullFile & { patch: string };
  comments: GitHubLineComment[];
  canComment: boolean;
  onComment: (anchor: Anchor, body: string) => Promise<GitHubActionResult>;
}) {
  const { t } = useAppTranslation();
  const rows = useMemo(() => numberPatch(file.patch), [file.patch]);
  const review = usePendingReview();
  // A removed and an added line can share a number; the side keeps the names apart.
  const lineLabel = (anchor: Anchor) =>
    t(
      anchor.side === 'LEFT'
        ? 'activity:github.lineComment.addRemoved'
        : 'activity:github.lineComment.add',
      { line: anchor.line },
    );
  const byAnchor = useMemo(() => {
    const map = new Map<string, GitHubLineComment[]>();
    for (const comment of comments)
      if (comment.line !== null) {
        const key = anchorKey({ line: comment.line, side: comment.side });
        map.set(key, [...(map.get(key) ?? []), comment]);
      }
    return map;
  }, [comments]);
  const outdated = comments.filter((comment) => comment.line === null);
  const [draft, setDraft] = useState<{ anchor: Anchor; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<GitHubActionResult | null>(null);
  const send = async () => {
    if (!draft?.text.trim()) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await onComment(draft.anchor, draft.text.trim());
      if (result.ok) setDraft(null);
      else setFailure(result);
    } catch (error) {
      setFailure({ ok: false, status: 'unavailable', message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="overflow-hidden rounded-lg border bg-background/40 text-xs">
      <div className="max-h-[32rem] overflow-auto font-mono leading-relaxed">
        {rows.map((row, index) => {
          const anchor = rowAnchor(row);
          const key = anchor ? anchorKey(anchor) : '';
          const here = anchor ? byAnchor.get(key) : undefined;
          const drafting = draft && anchor && anchorKey(draft.anchor) === key;
          return (
            <Fragment key={index}>
              <div
                className={cn(
                  'group flex items-start',
                  row.kind === 'add' && 'bg-success/10',
                  row.kind === 'del' && 'bg-destructive/10',
                  row.kind === 'meta' && 'bg-muted/60 text-muted-foreground',
                )}
              >
                <span className="w-10 shrink-0 select-none px-1 text-right text-muted-foreground/70">
                  {row.oldLine ?? ''}
                </span>
                <span className="w-10 shrink-0 select-none px-1 text-right text-muted-foreground/70">
                  {row.newLine ?? ''}
                </span>
                <span className="w-5 shrink-0 select-none text-center text-muted-foreground">
                  {anchor && canComment ? (
                    <button
                      type="button"
                      onClick={() => {
                        setFailure(null);
                        setDraft({ anchor, text: '' });
                      }}
                      aria-label={lineLabel(anchor)}
                      className="rounded text-primary opacity-0 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
                    >
                      <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  ) : row.kind === 'add' ? (
                    '+'
                  ) : row.kind === 'del' ? (
                    '-'
                  ) : (
                    ''
                  )}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-2">
                  {row.text}
                </span>
              </div>
              {here && <CommentList comments={here} />}
              {anchor &&
                review?.comments.map((comment, at) =>
                  comment.path === file.path && anchorKey(comment) === key ? (
                    <div
                      key={`pending:${at}`}
                      className="flex items-start gap-2 border-y border-primary/30 bg-primary/5 px-3 py-2 font-sans text-xs"
                    >
                      <span className="shrink-0 rounded-full border border-primary/40 px-2 py-0.5 text-[11px] text-primary">
                        {t('activity:github.pending.badge')}
                      </span>
                      <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                        {comment.body}
                      </p>
                      <button
                        type="button"
                        onClick={() => review.remove(at)}
                        aria-label={t('activity:github.pending.remove')}
                        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  ) : null,
                )}
              {drafting && (
                <div className="space-y-2 border-y border-border/60 bg-muted/20 p-2 font-sans">
                  <textarea
                    // biome-ignore lint/a11y/noAutofocus: opened by an explicit click on this line
                    autoFocus
                    value={draft.text}
                    onChange={(event) => setDraft({ ...draft, text: event.target.value })}
                    maxLength={10_000}
                    rows={3}
                    aria-label={lineLabel(draft.anchor)}
                    placeholder={t('activity:github.lineComment.placeholder')}
                    className="w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" disabled={busy || !draft.text.trim()} onClick={send}>
                      {t('activity:github.lineComment.send')}
                    </Button>
                    {review && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || !draft.text.trim()}
                        onClick={() => {
                          review.add({
                            path: file.path,
                            line: draft.anchor.line,
                            side: draft.anchor.side,
                            body: draft.text.trim(),
                          });
                          setDraft(null);
                        }}
                      >
                        {t('activity:github.pending.add')}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setDraft(null)}
                    >
                      {t('activity:github.confirm.no')}
                    </Button>
                  </div>
                  {failure && (
                    <p role="alert" className="text-xs">
                      {t(`activity:github.result.${failure.status}`)}
                      {failure.message && (
                        <span className="block break-words text-muted-foreground">
                          {failure.message}
                        </span>
                      )}
                    </p>
                  )}
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
      {outdated.length > 0 && (
        <div className="border-t border-border/60">
          <p className="px-3 pt-2 text-xs font-medium text-muted-foreground">
            {t('activity:github.lineComment.outdated')}
          </p>
          <CommentList comments={outdated} />
        </div>
      )}
    </div>
  );
}
