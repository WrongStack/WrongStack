import type { GitHubCreateResult, GitHubItemKind } from '@wrongstack/webui-protocol';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { useSurfaceHost } from '../host';
import { useAppTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';
import { Button } from '../ui/button';
import { useGitHubSessionId } from './github-session';
import { type GitHubSelection, pushBranchPrompt } from './github-view-model';
import { createGitHubItem, useGitHubCreateContext } from './use-github-create';

const field =
  'w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * A new issue, or a pull request from the project's checked-out branch. The
 * server never pushes: an unpushed branch is explained, and handed to an
 * agent only when the host offers a hand-off.
 */
export function GitHubCreateForm({
  kind,
  repository,
  onCreated,
  onCancel,
}: {
  kind: GitHubItemKind;
  repository: string;
  onCreated: (selection: GitHubSelection) => void;
  onCancel: () => void;
}) {
  const { t } = useAppTranslation();
  const sessionId = useGitHubSessionId();
  const github = useSurfaceHost().github;
  const HandOff = github?.HandOff;
  const pull = kind === 'pull';
  const { context, error, reload } = useGitHubCreateContext(sessionId, pull);
  const branch = context?.branch ?? null;
  const [title, setTitle] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [base, setBase] = useState<string | null>(null);
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [handing, setHanding] = useState<string | null>(null);
  const [result, setResult] = useState<GitHubCreateResult | null>(null);
  // A pull request's title starts as the last commit's subject until edited.
  const titleValue = title ?? (pull ? (branch?.subject ?? '') : '');
  const baseValue = base ?? context?.defaultBranch ?? '';
  const pushable = branch?.state === 'not-pushed' || branch?.state === 'out-of-sync';
  const canOpen =
    !pull ||
    (context?.status === 'ok' &&
      (branch?.state === 'ready' || branch?.state === 'out-of-sync') &&
      !branch.openPull);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setResult(null);
    try {
      const value = await createGitHubItem(
        sessionId,
        pull
          ? {
              kind: 'pull',
              title: titleValue.trim(),
              body,
              base: baseValue.trim(),
              head: branch?.name ?? '',
              draft,
            }
          : { kind: 'issue', title: titleValue.trim(), body },
      );
      setResult(value);
      if (value.ok && value.item) onCreated({ kind: value.item.kind, number: value.item.number });
    } catch (reason) {
      setResult({ ok: false, status: 'unavailable', message: (reason as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const handOffPush = () => {
    if (!branch?.name) return;
    const prompt = pushBranchPrompt(repository, branch.name);
    if (github?.handOff) github.handOff(prompt);
    else setHanding(prompt);
  };
  return (
    <section
      aria-label={t(
        pull ? 'activity:github.create.pullTitle' : 'activity:github.create.issueTitle',
      )}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          <ArrowLeft className="h-4 w-4" />
          <span className="ml-1">{t('activity:github.back')}</span>
        </Button>
        <h2 className="text-sm font-medium">
          {t(pull ? 'activity:github.create.pullTitle' : 'activity:github.create.issueTitle')}
        </h2>
      </div>
      <form
        className="space-y-3 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {pull && error && (
          <div role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm">
            {t('activity:github.status.unavailable')}
            <p className="mt-1 break-words text-muted-foreground">{error}</p>
          </div>
        )}
        {pull && !context && !error && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('activity:github.loading')}
          </p>
        )}
        {pull && context && context.status !== 'ok' && (
          <p role="status" className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
            {t(`activity:github.status.${context.status}`)}
          </p>
        )}
        {pull && branch && (
          <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3 text-sm">
            {branch.name && (
              <p>
                {t('activity:github.create.fromBranch')}{' '}
                <span className="break-all font-mono text-xs">{branch.name}</span>
              </p>
            )}
            <p
              role={branch.state === 'ready' ? undefined : 'status'}
              className="text-muted-foreground"
            >
              {t(`activity:github.create.branch.${branch.state}`, {
                base: context?.defaultBranch ?? '',
              })}
            </p>
            {branch.openPull && (
              <p className="flex flex-wrap items-center gap-2">
                <span>
                  {t('activity:github.create.openPull', {
                    number: branch.openPull.number,
                    title: branch.openPull.title,
                  })}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onCreated({ kind: 'pull', number: branch.openPull!.number })}
                >
                  {t('activity:github.create.showOpenPull')}
                </Button>
              </p>
            )}
            {pushable && (
              <div className="flex flex-wrap gap-2">
                {(github?.handOff || HandOff) && (
                  <Button type="button" size="sm" variant="outline" onClick={handOffPush}>
                    {t('activity:github.create.askToPush')}
                  </Button>
                )}
                <Button type="button" size="sm" variant="ghost" onClick={reload}>
                  {t('activity:github.create.checkAgain')}
                </Button>
              </div>
            )}
            {handing && HandOff && <HandOff prompt={handing} onDone={() => setHanding(null)} />}
          </div>
        )}
        {canOpen && (
          <>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">
                {t('activity:github.create.titleLabel')}
              </span>
              <input
                value={titleValue}
                maxLength={256}
                required
                onChange={(event) => setTitle(event.target.value)}
                className={field}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">
                {t('activity:github.create.bodyLabel')}
              </span>
              <textarea
                value={body}
                maxLength={20_000}
                rows={6}
                onChange={(event) => setBody(event.target.value)}
                className={cn(field, 'resize-y')}
              />
            </label>
            {pull && (
              <div className="flex flex-wrap items-end gap-4">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted-foreground">
                    {t('activity:github.create.baseLabel')}
                  </span>
                  <input
                    value={baseValue}
                    maxLength={200}
                    required
                    onChange={(event) => setBase(event.target.value)}
                    className={cn(field, 'font-mono')}
                  />
                </label>
                <label className="flex items-center gap-2 pb-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft}
                    onChange={(event) => setDraft(event.target.checked)}
                  />
                  {t('activity:github.create.draft')}
                </label>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={busy || !titleValue.trim()}>
                {busy
                  ? t('activity:github.working')
                  : t(
                      pull
                        ? 'activity:github.create.submitPull'
                        : 'activity:github.create.submitIssue',
                    )}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={onCancel}>
                {t('activity:github.confirm.no')}
              </Button>
            </div>
          </>
        )}
        {result && !result.ok && (
          <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs"
          >
            {pull && result.status === 'conflict'
              ? t('activity:github.create.branchChanged')
              : t(`activity:github.result.${result.status}`)}
            {result.message && (
              <p className="mt-1 break-words text-muted-foreground">{result.message}</p>
            )}
          </div>
        )}
      </form>
    </section>
  );
}
