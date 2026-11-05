import { FileCode2 } from 'lucide-react';
import { deadCodeLabel } from './dead-code-model';
import { useDesktopText } from './desktop-i18n';
import { entries } from './engine-values';

/**
 * Names an engine value per language; a value the catalog does not know reads as before.
 * `start` is for a label standing on its own; inside a sentence the value stays as written.
 */
export function useDeadCodeLabel() {
  const { t, i18n } = useDesktopText();
  return (value: unknown, start = false) => {
    const text =
      typeof value === 'string'
        ? t(`deadCode.value.${value}`, { defaultValue: deadCodeLabel(value) })
        : t('deadCode.notReported');
    return start ? text.charAt(0).toLocaleUpperCase(i18n.language) + text.slice(1) : text;
  };
}

export function DeadCodePlan({
  plan,
  onOpenFile,
}: {
  plan: Record<string, unknown>;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useDesktopText();
  const label = useDeadCodeLabel();
  return (
    <section className="dead-code-plan" aria-label={t('deadCode.plan.label')}>
      <h2>{t('deadCode.plan.title')}</h2>
      <p>
        {t('deadCode.plan.counts', {
          edit: t('deadCode.count.edit', {
            count: entries(plan['changes']).filter((item) => item['action'] === 'edit').length,
          }),
          remove: t('deadCode.count.remove', {
            count: entries(plan['changes']).filter((item) => item['action'] === 'delete').length,
          }),
        })}
      </p>
      {(Array.isArray(plan['notes']) ? plan['notes'] : []).map((note, index) => (
        <p className="field-help" key={index}>
          {String(note)}
        </p>
      ))}
      {entries(plan['changes']).map((change) => (
        <article
          key={String(change['file'])}
          aria-label={t('deadCode.plan.diff', { file: change['file'] })}
        >
          <header>
            <button
              type="button"
              className="button secondary small"
              onClick={() => onOpenFile(String(change['file']))}
            >
              <FileCode2 size={13} />
              {String(change['file'])}
            </button>
            <strong>{label(change['action'], true)}</strong>
          </header>
          <pre className="dead-code-diff">
            {String(change['diff'] ?? '')
              .split('\n')
              .map((line, index) => (
                <span
                  key={index}
                  className={
                    line.startsWith('+') && !line.startsWith('+++')
                      ? 'dead-diff-add'
                      : line.startsWith('-') && !line.startsWith('---')
                        ? 'dead-diff-remove'
                        : line.startsWith('@@')
                          ? 'dead-diff-location'
                          : ''
                  }
                >
                  {line}
                </span>
              ))}
          </pre>
        </article>
      ))}
      {entries(plan['skipped']).length > 0 && (
        <details>
          <summary>{t('deadCode.plan.skipped', { n: entries(plan['skipped']).length })}</summary>
          {entries(plan['skipped']).map((item, index) => (
            <p key={index}>
              <code>{String(item['id'])}</code> · {String(item['reason'])}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
export function DeadCodeResult({ result }: { result: Record<string, unknown> }) {
  const { t } = useDesktopText();
  return (
    <section className="dead-code-result" aria-label={t('deadCode.result.label')} role="status">
      <h2>
        {result['rolledBack'] === true
          ? t('deadCode.result.rolledBack')
          : result['ok'] === true
            ? t('deadCode.result.completed')
            : t('deadCode.result.incomplete')}
      </h2>
      <p>
        {t('deadCode.result.counts', {
          changed: t('deadCode.count.changed', {
            count: Array.isArray(result['changed']) ? result['changed'].length : 0,
          }),
          deleted: t('deadCode.count.deleted', {
            count: Array.isArray(result['deleted']) ? result['deleted'].length : 0,
          }),
          attempts: t('deadCode.count.attempts', { count: Number(result['attempts'] ?? 0) }),
        })}
      </p>
      {(['changed', 'deleted'] as const).map((key) =>
        Array.isArray(result[key]) && result[key].length > 0 ? (
          <details key={key}>
            <summary>{t(`deadCode.result.files.${key}`)}</summary>
            <ul>
              {result[key].map((file: unknown, index: number) => (
                <li key={index}>{String(file)}</li>
              ))}
            </ul>
          </details>
        ) : null,
      )}
      {entries(result['verify']).length ? (
        entries(result['verify']).map((step, index) => (
          <details key={index}>
            <summary>
              {String(step['package'])} ·{' '}
              {step['ok'] === true ? t('deadCode.result.passed') : t('deadCode.result.failed')} ·{' '}
              {Number(step['durationMs']) / 1000}s
            </summary>
            <code>{String(step['command'])}</code>
            <pre>{String(step['output'] ?? '')}</pre>
          </details>
        ))
      ) : (
        <p>{t('deadCode.result.noSteps')}</p>
      )}
      {entries(result['excluded']).length > 0 && (
        <details>
          <summary>
            {t('deadCode.result.excluded', { n: entries(result['excluded']).length })}
          </summary>
          {entries(result['excluded']).map((item, index) => (
            <p key={index}>
              {String(item['id'])} · {String(item['reason'])}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
