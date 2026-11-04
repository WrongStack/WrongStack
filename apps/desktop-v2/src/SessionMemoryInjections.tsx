import { Brain } from 'lucide-react';
import { useDesktopText } from './desktop-i18n';
import type { MemoryContext, MemoryInjectorRun } from './memory-injections';
import { recoveryDate } from './session-recovery-model';

/**
 * What SAGE put into this conversation's model context, as the engine reported it: the
 * memories the latest request carried, and each injector decision with what it rejected and why.
 * Only runs present in this conversation's engine event log are listed.
 */
export function SessionMemoryInjections({
  runs,
  context,
}: {
  runs: MemoryInjectorRun[];
  context: MemoryContext | null;
}) {
  const { t } = useDesktopText();
  const memories = (count: number) =>
    count === 1
      ? t('memoryInjections.oneMemory')
      : t('memoryInjections.memories', { number: count });
  return (
    <section className="memory-injections" aria-label={t('memoryInjections.label')}>
      <header>
        <Brain size={14} />
        <strong>{t('memoryInjections.label')}</strong>
      </header>
      <p className="settings-defaults-note">
        {context
          ? t(
              context.active.length === 1
                ? 'memoryInjections.carriedOne'
                : 'memoryInjections.carriedMany',
              {
                number: context.active.length,
                entered: context.entered.length,
                left: context.exited.length,
                at: recoveryDate(context.at),
              },
            )
          : t('memoryInjections.notYet')}
      </p>
      {!runs.length && <p className="quiet-state">{t('memoryInjections.noRuns')}</p>}
      <ol aria-label={t('memoryInjections.runs')}>
        {runs
          .slice()
          .reverse()
          .map((run) => (
            <li key={run.runId}>
              <details>
                <summary>
                  <strong>{t(`memoryInjections.outcome.${run.outcome}`)}</strong>
                  {run.outcome === 'injected' && ` · ${memories(run.injected.length)}`}
                  {' · '}
                  {run.toolName || run.trigger || t('memoryInjections.turn')} ·{' '}
                  {recoveryDate(run.at)}
                </summary>
                {run.queryPreview && <p className="memory-injection-query">{run.queryPreview}</p>}
                <p>
                  {t('memoryInjections.counts', {
                    candidates: run.candidates,
                    eligible: run.eligible,
                  })}
                  {run.minScore === null
                    ? ''
                    : ` · ${t('memoryInjections.scoreBar', { score: run.minScore })}`}
                  {run.injectedChars
                    ? ` · ${t('memoryInjections.chars', { number: run.injectedChars })}`
                    : ''}
                </p>
                {run.rejected.length > 0 && (
                  <p>
                    {t('memoryInjections.rejected', {
                      list: run.rejected.map((item) => `${item.gate} ${item.count}`).join(' · '),
                    })}
                  </p>
                )}
                {run.error && (
                  <p role="alert" className="session-error">
                    {run.error}
                  </p>
                )}
                {run.injected.length > 0 && (
                  <ul aria-label={t('memoryInjections.injectedList')}>
                    {run.injected.map((memory) => (
                      <li key={memory.id}>
                        <small>
                          {memory.kind}
                          {memory.score === null
                            ? ''
                            : ` · ${t('memoryInjections.score', { score: memory.score.toFixed(2) })}`}
                        </small>
                        <span>{memory.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            </li>
          ))}
      </ol>
    </section>
  );
}
