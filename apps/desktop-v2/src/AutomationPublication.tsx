import type { AutomationPullRequestView, AutomationRunRecord } from '@wrongstack/webui-protocol';
import { useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineHttp } from './engine-http';
import { MarkdownContent } from './MarkdownContent';
import { openExternal } from './platform';

export function AutomationPublication({
  run,
  http,
}: {
  run: AutomationRunRecord;
  http: EngineHttp;
}) {
  const { t } = useDesktopText();
  const [view, setView] = useState<AutomationPullRequestView | null>(null),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [repository, setRepository] = useState(''),
    [base, setBase] = useState('main'),
    [title, setTitle] = useState(''),
    [reviewPublish, setReviewPublish] = useState(false),
    [reviewFollowUp, setReviewFollowUp] = useState(false);
  const alive = useRef(true),
    working = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const perform = async (operation = '', body?: unknown) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const next = (await http(
        `/api/automation/runs/${run.id}/pr${operation ? `/${operation}` : ''}`,
        operation ? 'POST' : 'GET',
        body,
      )) as AutomationPullRequestView;
      if (!alive.current) return;
      setView(next);
      setOpen(true);
      setReviewPublish(false);
      setReviewFollowUp(false);
      if (!next.plan && next.suggestedTarget) {
        setRepository(next.suggestedTarget.repository);
        setBase(next.suggestedTarget.base);
        setTitle(next.suggestedTarget.title);
      }
    } catch (error) {
      if (alive.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const checks = run.result?.validation.checks;
  const eligible =
    run.status === 'completed' &&
    run.result?.validation.status === 'passed' &&
    !!checks?.length &&
    checks.every((check) => check.exitCode === 0);
  return (
    <section className="automation-publication" aria-label={t('autoPr.label')}>
      <header>
        <h3>{t('autoPr.heading')}</h3>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void perform()}
        >
          {open ? t('autoPr.refresh') : t('autoPr.review')}
        </button>
      </header>
      <p>{t('autoPr.intro')}</p>
      {!eligible && <p className="quiet-state">{t('autoPr.notEligible')}</p>}
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
      {busy && <p role="status">{t('autoPr.busy')}</p>}
      {open &&
        view &&
        (view.plan ? (
          <>
            <dl>
              <dt>{t('autoPr.repository')}</dt>
              <dd>{view.plan.repository}</dd>
              <dt>{t('autoPr.base')}</dt>
              <dd>
                {view.plan.base} · <code>{view.plan.baseCommit}</code>
              </dd>
              <dt>{t('autoPr.branch')}</dt>
              <dd>{view.plan.branch}</dd>
              <dt>{t('autoPr.title')}</dt>
              <dd>{view.plan.title}</dd>
              {view.plan.target && (
                <>
                  <dt>{t('autoPr.existing')}</dt>
                  <dd>
                    #{view.plan.target.number} · <code>{view.plan.target.headCommit}</code>
                  </dd>
                </>
              )}
            </dl>
            <h4>{t('autoPr.reviewedFiles')}</h4>
            <ul>
              {view.plan.files.map((file) => (
                <li key={file}>
                  <code>{file}</code>
                </li>
              ))}
            </ul>
            <details>
              <summary>{t('autoPr.identity')}</summary>
              <MarkdownContent text={view.plan.body} />
              <dl>
                <dt>{t('autoPr.planFingerprint')}</dt>
                <dd>
                  <code>{view.plan.fingerprint}</code>
                </dd>
                <dt>{t('autoPr.patchSha')}</dt>
                <dd>
                  <code>{view.plan.patchSha256}</code>
                </dd>
                <dt>{t('autoPr.verificationSha')}</dt>
                <dd>
                  <code>{view.plan.verificationSha256}</code>
                </dd>
                <dt>{t('autoPr.trees')}</dt>
                <dd>
                  <code>
                    {view.plan.sourceTree} / {view.plan.candidateTree}
                  </code>
                </dd>
              </dl>
            </details>
            {view.receipt ? (
              <div className="feature-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() =>
                    void openExternal(view.receipt!.url).catch((error) => setError(String(error)))
                  }
                >
                  {t('autoPr.openDraft', { number: view.receipt.number })}
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void perform('check', {})}
                >
                  {t('autoPr.checkCi')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="button primary"
                disabled={busy || !eligible}
                onClick={() => setReviewPublish(true)}
              >
                {view.plan.target ? t('autoPr.reviewUpdate') : t('autoPr.reviewPublish')}
              </button>
            )}
            {reviewPublish && (
              <div className="automation-leave" role="alert">
                <h4>{view.plan.target ? t('autoPr.askUpdate') : t('autoPr.askPublish')}</h4>
                <p>
                  {t(view.plan.target ? 'autoPr.pushUpdate' : 'autoPr.pushCreate', {
                    repository: view.plan.repository,
                  })}
                </p>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setReviewPublish(false)}
                >
                  {t('autoPr.keepUnpublished')}
                </button>
                <button
                  type="button"
                  className="button primary"
                  disabled={busy}
                  onClick={() => void perform('publish', { fingerprint: view.plan!.fingerprint })}
                >
                  {t('autoPr.publish')}
                </button>
              </div>
            )}
            {view.ci && (
              <section>
                <h4>
                  {t('autoPr.ciChecks', {
                    status: t(`autoPr.ciStatus.${view.ci.status}`, {
                      defaultValue: view.ci.status,
                    }),
                  })}
                </h4>
                <p>
                  <code>{view.ci.commit}</code> ·{' '}
                  {t('autoPr.checked', { time: new Date(view.ci.checkedAt).toLocaleString() })}
                </p>
                {view.ci.checks.map((check, index) => (
                  <article key={index}>
                    <strong>{check.name}</strong>
                    <p>{check.conclusion ?? check.status}</p>
                    {check.details && <pre className="automation-run-log">{check.details}</pre>}
                  </article>
                ))}
                {view.ci.status === 'failed' && view.ci.fingerprint && !view.followUpRunId && (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={() => setReviewFollowUp(true)}
                  >
                    {t('autoPr.reviewFollowUp')}
                  </button>
                )}
                {reviewFollowUp && (
                  <div className="automation-leave" role="alert">
                    <p>{t('autoPr.followUpAsk')}</p>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy}
                      onClick={() => setReviewFollowUp(false)}
                    >
                      {t('autoPr.keepRun')}
                    </button>
                    <button
                      type="button"
                      className="button primary"
                      disabled={busy}
                      onClick={() =>
                        void perform('follow-up', { fingerprint: view.ci!.fingerprint })
                      }
                    >
                      {t('autoPr.queueFollowUp')}
                    </button>
                  </div>
                )}
              </section>
            )}
            {view.followUpRunId && (
              <p role="status">
                {t('autoPr.followUpQueued')} <code>{view.followUpRunId}</code>
              </p>
            )}
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void perform('prepare', { repository, base, title });
            }}
          >
            <fieldset disabled={busy || !eligible}>
              <legend>{t('autoPr.prepareLegend')}</legend>
              <label>
                {t('autoPr.repository')}
                <input
                  aria-label={t('autoPr.repositoryLabel')}
                  required
                  placeholder="owner/repository"
                  value={repository}
                  onChange={(event) => setRepository(event.target.value)}
                />
              </label>
              <label>
                {t('autoPr.baseBranch')}
                <input
                  aria-label={t('autoPr.baseLabel')}
                  required
                  value={base}
                  onChange={(event) => setBase(event.target.value)}
                />
              </label>
              <label>
                {t('autoPr.prTitle')}
                <input
                  aria-label={t('autoPr.titleLabel')}
                  required
                  maxLength={200}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <button type="submit" className="button secondary">
                {t('autoPr.preparePlan')}
              </button>
            </fieldset>
          </form>
        ))}
    </section>
  );
}
