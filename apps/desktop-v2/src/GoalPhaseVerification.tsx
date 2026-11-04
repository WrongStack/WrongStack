import { useDesktopText } from './desktop-i18n';
import { entries } from './engine-values';
import { recoveryDate } from './session-recovery-model';

const INTEGRATION = new Set(['merged', 'needs_review', 'merge_failed']);

export interface PhaseVerificationAttempt {
  attempt: number;
  ok: boolean;
  /** Passed only because the checker found nothing to run. */
  skipped: boolean;
  at: number | null;
  output: string;
}

/** "skipped" is kept apart from "passed": nothing was checked. */
const verdict = (item: PhaseVerificationAttempt) =>
  item.skipped ? 'skipped' : item.ok ? 'passed' : 'failed';

/** Verification attempts the engine recorded on a Goal phase, oldest first. */
export function phaseVerificationAttempts(phase: Record<string, unknown>) {
  return entries(phase['verificationAttempts']).flatMap((item): PhaseVerificationAttempt[] =>
    typeof item['attempt'] === 'number' && typeof item['ok'] === 'boolean'
      ? [
          {
            attempt: item['attempt'],
            ok: item['ok'],
            skipped: item['skipped'] === true,
            at: typeof item['at'] === 'number' ? item['at'] : null,
            output: typeof item['output'] === 'string' ? item['output'] : '',
          },
        ]
      : [],
  );
}

/** A phase's verification gate attempts and integration state, when the engine recorded them. */
export function GoalPhaseVerification({ phase }: { phase: Record<string, unknown> }) {
  const { t } = useDesktopText();
  const attempts = phaseVerificationAttempts(phase);
  const integration =
    typeof phase['integrationStatus'] === 'string' ? phase['integrationStatus'] : '';
  if (!attempts.length && !integration) return null;
  const last = attempts.at(-1);
  return (
    <details className="goal-phase-verification">
      <summary>
        {last
          ? t(attempts.length === 1 ? 'phaseVerify.summaryOne' : 'phaseVerify.summaryMany', {
              verdict: t(`phaseVerify.${verdict(last)}`),
              n: attempts.length,
            })
          : t('phaseVerify.integrationTitle')}
        {integration
          ? ` · ${INTEGRATION.has(integration) ? t(`phaseVerify.integration.${integration}`) : integration}`
          : ''}
      </summary>
      <ol aria-label={t('phaseVerify.attempts')}>
        {attempts.map((item) => (
          <li
            key={item.attempt}
            className={item.skipped ? 'skipped' : item.ok ? 'passed' : 'failed'}
          >
            <strong>
              {item.attempt === 0
                ? t('phaseVerify.firstCheck')
                : t('phaseVerify.afterRepair', { n: item.attempt })}{' '}
              · {t(`phaseVerify.${verdict(item)}`)}
            </strong>
            {item.at !== null && <small> · {recoveryDate(new Date(item.at).toISOString())}</small>}
            {item.output && <pre>{item.output}</pre>}
          </li>
        ))}
      </ol>
      {attempts.some((item) => item.output.length >= 4000) && (
        <p className="settings-defaults-note">{t('phaseVerify.longOutput')}</p>
      )}
    </details>
  );
}
