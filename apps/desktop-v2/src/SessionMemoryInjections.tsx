import { Brain } from 'lucide-react';
import type { MemoryContext, MemoryInjectorRun } from './memory-injections';
import { recoveryDate } from './session-recovery-model';

const OUTCOME: Record<MemoryInjectorRun['outcome'], string> = {
  injected: 'Injected',
  empty: 'Nothing injected',
  error: 'Injector error',
};

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
  return (
    <section className="memory-injections" aria-label="Memory in context">
      <header>
        <Brain size={14} />
        <strong>Memory in context</strong>
      </header>
      <p className="settings-defaults-note">
        {context
          ? `The latest request carried ${context.active.length} SAGE ${
              context.active.length === 1 ? 'memory' : 'memories'
            } · ${context.entered.length} entered · ${context.exited.length} left (${recoveryDate(context.at)}).`
          : 'The engine has not reported the memory context of a request yet.'}
      </p>
      {!runs.length && (
        <p className="quiet-state">
          The engine has reported no memory injector runs for this conversation.
        </p>
      )}
      <ol aria-label="Memory injector runs">
        {runs
          .slice()
          .reverse()
          .map((run) => (
            <li key={run.runId}>
              <details>
                <summary>
                  <strong>{OUTCOME[run.outcome]}</strong>
                  {run.outcome === 'injected' &&
                    ` · ${run.injected.length} ${run.injected.length === 1 ? 'memory' : 'memories'}`}
                  {' · '}
                  {run.toolName || run.trigger || 'turn'} · {recoveryDate(run.at)}
                </summary>
                {run.queryPreview && <p className="memory-injection-query">{run.queryPreview}</p>}
                <p>
                  {run.candidates} candidates · {run.eligible} eligible
                  {run.minScore === null ? '' : ` · score bar ${run.minScore}`}
                  {run.injectedChars ? ` · ${run.injectedChars} characters added` : ''}
                </p>
                {run.rejected.length > 0 && (
                  <p>
                    Rejected: {run.rejected.map((item) => `${item.gate} ${item.count}`).join(' · ')}
                  </p>
                )}
                {run.error && (
                  <p role="alert" className="session-error">
                    {run.error}
                  </p>
                )}
                {run.injected.length > 0 && (
                  <ul aria-label="Injected memories">
                    {run.injected.map((memory) => (
                      <li key={memory.id}>
                        <small>
                          {memory.kind}
                          {memory.score === null ? '' : ` · score ${memory.score.toFixed(2)}`}
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
