import type { AutomationRunRecord } from '@wrongstack/webui-protocol';
import { X } from 'lucide-react';
import { changedFileOverlap, runFacts } from './automation-run-compare';
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
  const facts = runFacts(left, right);
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
        <p className="quiet-state">None.</p>
      )}
    </section>
  );
  return (
    <Modal title="Compare automation runs" onClose={onClose}>
      <div className="automation-run-comparison">
        <header>
          <h2>Compare runs</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close run comparison"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <table aria-label="Run comparison">
          <thead>
            <tr>
              <th scope="col">Recorded</th>
              <th scope="col">Run {left.id.slice(0, 8)}</th>
              <th scope="col">Run {right.id.slice(0, 8)}</th>
            </tr>
          </thead>
          <tbody>
            {facts.map((fact) => (
              <tr key={fact.label} className={fact.differs ? 'differs' : undefined}>
                <th scope="row">{fact.label}</th>
                <td>{fact.left}</td>
                <td>{fact.right}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>Changed files</h3>
        {files.partial && (
          <p className="field-help">
            At least one run's list was truncated at 200 files, so "only" lists may be incomplete.
          </p>
        )}
        <div className="automation-run-comparison-files">
          {list(`Only run ${left.id.slice(0, 8)}`, files.onlyLeft)}
          {list('Both runs', files.both)}
          {list(`Only run ${right.id.slice(0, 8)}`, files.onlyRight)}
        </div>
      </div>
    </Modal>
  );
}
