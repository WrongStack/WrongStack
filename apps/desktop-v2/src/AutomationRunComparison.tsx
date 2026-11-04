import type { AutomationRunRecord } from '@wrongstack/webui-protocol';
import { X } from 'lucide-react';
import { changedFileOverlap, type RunFact, runFacts } from './automation-run-compare';
import { useDesktopText } from './desktop-i18n';
import { Modal } from './Modal';

/** Two runs' recorded results side by side; nothing is re-run or fetched. */
export function AutomationRunComparison({
  left,
  right,
  onClose,
}: {
  left: AutomationRunRecord;
  right: AutomationRunRecord;
  onClose: () => void;
}) {
  const { t } = useDesktopText();
  const facts = runFacts(left, right, {
    notRecorded: t('autoRun.notRecorded'),
    truncated: t('autoRun.truncated'),
  });
  // Engine words in a fact's cells are named per language; the rest are shown as recorded.
  const cell = (fact: RunFact, value: string) =>
    fact.id === 'status'
      ? t(`automation.runStatus.${value}`, { defaultValue: value })
      : fact.id === 'trigger'
        ? t(`automation.trigger.${value}`, { defaultValue: value })
        : fact.id === 'verification'
          ? t(`autoRun.verify.${value}`, { defaultValue: value })
          : value;
  const files = changedFileOverlap(left, right);
  const list = (title: string, paths: string[]) => (
    <section>
      <h4>
        {title} · {paths.length}
      </h4>
      {paths.length ? (
        <ul>
          {paths.map((path) => (
            <li key={path}>
              <code>{path}</code>
            </li>
          ))}
        </ul>
      ) : (
        <p className="quiet-state">{t('autoRun.none')}</p>
      )}
    </section>
  );
  return (
    <Modal title={t('autoRun.compareTitle')} onClose={onClose}>
      <div className="automation-run-comparison">
        <header>
          <h2>{t('autoRun.compareHeading')}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label={t('autoRun.closeCompare')}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <table aria-label={t('autoRun.compareTable')}>
          <thead>
            <tr>
              <th scope="col">{t('autoRun.recorded')}</th>
              <th scope="col">{t('autoRun.run', { id: left.id.slice(0, 8) })}</th>
              <th scope="col">{t('autoRun.run', { id: right.id.slice(0, 8) })}</th>
            </tr>
          </thead>
          <tbody>
            {facts.map((fact) => (
              <tr key={fact.id} className={fact.differs ? 'differs' : undefined}>
                <th scope="row">{t(`autoRun.fact.${fact.id}`)}</th>
                <td>{cell(fact, fact.left)}</td>
                <td>{cell(fact, fact.right)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>{t('autoRun.changedFiles')}</h3>
        {files.partial && <p className="field-help">{t('autoRun.partial')}</p>}
        <div className="automation-run-comparison-files">
          {list(t('autoRun.onlyRun', { id: left.id.slice(0, 8) }), files.onlyLeft)}
          {list(t('autoRun.bothRuns'), files.both)}
          {list(t('autoRun.onlyRun', { id: right.id.slice(0, 8) }), files.onlyRight)}
        </div>
      </div>
    </Modal>
  );
}
