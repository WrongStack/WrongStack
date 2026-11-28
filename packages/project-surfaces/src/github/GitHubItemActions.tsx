import type {
  GitHubAction,
  GitHubActionResult,
  GitHubItemDetail,
  GitHubMergeMethod,
} from '@wrongstack/webui-protocol';
import { useState } from 'react';
import { useAppTranslation } from '../lib/i18n';
import { Button } from '../ui/button';
import { useGitHubSessionId } from './github-session';
import { checkTone } from './github-view-model';
import { usePendingReview } from './pending-review';
import { runGitHubAction } from './use-github-item';

type Confirmable = 'merge' | 'close';

/**
 * Writes on one item. Every button is a user action; merge and close take a
 * second, in-page confirmation. Reviews and merges carry the head SHA shown,
 * so GitHub refuses them if the branch moved since the pane loaded.
 */
export function GitHubItemActions({
  item,
  repository,
  canWrite,
  onDone,
}: {
  item: GitHubItemDetail;
  repository: string;
  canWrite: boolean;
  onDone: () => void;
}) {
  const { t } = useAppTranslation();
  const sessionId = useGitHubSessionId();
  const [text, setText] = useState('');
  const [method, setMethod] = useState<GitHubMergeMethod>('squash');
  const [confirming, setConfirming] = useState<Confirmable | null>(null);
  const [busy, setBusy] = useState<GitHubAction | null>(null);
  const [result, setResult] = useState<{ action: GitHubAction; value: GitHubActionResult } | null>(
    null,
  );
  const pull = item.pull;
  const open = item.state === 'open';
  const review = usePendingReview();
  const pending = review?.comments ?? [];
  const isReview = (action: GitHubAction) =>
    action === 'approve' || action === 'request-changes' || action === 'review';
  const run = async (action: GitHubAction) => {
    setConfirming(null);
    setBusy(action);
    setResult(null);
    try {
      const value = await runGitHubAction(sessionId, {
        kind: item.kind,
        number: item.number,
        action,
        ...(text.trim() && action !== 'merge' && action !== 'close' && action !== 'reopen'
          ? { body: text.trim() }
          : {}),
        ...(action === 'merge' ? { mergeMethod: method } : {}),
        ...(isReview(action) && pending.length ? { comments: pending } : {}),
        ...(pull &&
        (action === 'approve' ||
          action === 'request-changes' ||
          action === 'merge' ||
          action === 'rerun-failed' ||
          action === 'review')
          ? { expectedHeadSha: pull.headSha }
          : {}),
      });
      setResult({ action, value });
      if (value.ok) {
        if (action === 'comment' || isReview(action)) setText('');
        if (isReview(action)) review?.clear();
        onDone();
      }
    } catch (error) {
      setResult({
        action,
        value: { ok: false, status: 'unavailable', message: (error as Error).message },
      });
    } finally {
      setBusy(null);
    }
  };
  if (!canWrite)
    return (
      <p className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        {t('activity:github.writeNeedsToken')}
      </p>
    );
  const disabled = busy !== null;
  return (
    <section aria-label={t('activity:github.actions')} className="space-y-3">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-muted-foreground">
          {t('activity:github.commentLabel')}
        </span>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxLength={10_000}
          rows={3}
          placeholder={t('activity:github.commentPlaceholder')}
          className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || !text.trim()}
          onClick={() => run('comment')}
        >
          {t('activity:github.action.comment')}
        </Button>
        {pull && open && !pull.merged && (
          <>
            {pending.length > 0 && (
              <Button size="sm" disabled={disabled} onClick={() => run('review')}>
                {t('activity:github.pending.submit', { count: pending.length })}
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={disabled} onClick={() => run('approve')}>
              {t('activity:github.action.approve')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || !text.trim()}
              onClick={() => run('request-changes')}
            >
              {t('activity:github.action.request-changes')}
            </Button>
            {pull.checks?.some((check) => checkTone(check) === 'fail') && (
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => run('rerun-failed')}
              >
                {t('activity:github.action.rerun-failed')}
              </Button>
            )}
          </>
        )}
      </div>
      {open && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
          {pull && !pull.merged && (
            <>
              <select
                aria-label={t('activity:github.mergeMethod')}
                value={method}
                onChange={(event) => setMethod(event.target.value as GitHubMergeMethod)}
                className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              >
                {(['squash', 'merge', 'rebase'] as const).map((value) => (
                  <option key={value} value={value}>
                    {t(`activity:github.method.${value}`)}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={disabled || pull.draft || pull.mergeable === false}
                onClick={() => setConfirming('merge')}
              >
                {t('activity:github.action.merge')}
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => setConfirming('close')}
          >
            {t('activity:github.action.close')}
          </Button>
        </div>
      )}
      {!open && !pull?.merged && (
        <div className="border-t border-border/60 pt-3">
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => run('reopen')}>
            {t('activity:github.action.reopen')}
          </Button>
        </div>
      )}
      {confirming && (
        <div
          role="alertdialog"
          aria-label={t(`activity:github.confirm.${confirming}`, {
            number: item.number,
            method: t(`activity:github.method.${method}`),
            base: pull?.baseRef ?? '',
            repository,
          })}
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
        >
          <p>
            {t(`activity:github.confirm.${confirming}`, {
              number: item.number,
              method: t(`activity:github.method.${method}`),
              base: pull?.baseRef ?? '',
              repository,
            })}
          </p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="destructive" onClick={() => run(confirming)}>
              {t('activity:github.confirm.yes')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setConfirming(null)}>
              {t('activity:github.confirm.no')}
            </Button>
          </div>
        </div>
      )}
      {busy && (
        <p role="status" className="text-xs text-muted-foreground">
          {t('activity:github.working')}
        </p>
      )}
      {result && (
        <div
          role={result.value.ok ? 'status' : 'alert'}
          className="rounded-lg border border-border bg-muted/30 p-3 text-xs"
        >
          {result.value.ok
            ? t(`activity:github.done.${result.action}`, { number: item.number })
            : t(`activity:github.result.${result.value.status}`)}
          {result.value.message && (
            <p className="mt-1 break-words text-muted-foreground">{result.value.message}</p>
          )}
        </div>
      )}
    </section>
  );
}
