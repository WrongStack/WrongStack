import { entries, record } from './engine-values';

/**
 * The Brain's deterministic rules as the WebUI's settings list them: evaluated before any provider
 * call, first match wins, read-only here (they are edited in the global config file). Rules the
 * loader dropped are listed with the reason it gave.
 */
export function BrainRules({ snapshot }: { snapshot: Record<string, unknown> }) {
  const rules = entries(snapshot['rules']);
  const dropped = Array.isArray(snapshot['ruleErrors'])
    ? snapshot['ruleErrors'].filter((error): error is string => typeof error === 'string')
    : [];
  return (
    <article className="brain-policy-card brain-rules" aria-label="Deterministic rules">
      <header>
        <h3>Deterministic rules</h3>
        <span className="sdd-chip">{rules.length} configured</span>
      </header>
      <p className="field-help">
        Evaluated before any provider call; the first match wins. Edit them in the global config
        file; this view is read-only.
      </p>
      {rules.length > 0 && (
        <ol>
          {rules.map((rule, index) => (
            <li key={`${String(rule['id'])}-${index}`}>
              <code>{String(rule['id'] ?? `rule ${index + 1}`)}</code>
              <span className="sdd-chip">
                {String(record(rule['then'])['action'] ?? 'no action')}
              </span>
              {rule['enabled'] === false && <span className="sdd-chip">off</span>}
            </li>
          ))}
        </ol>
      )}
      {dropped.length > 0 && (
        <div className="brain-rules-dropped" role="note">
          <strong>
            {dropped.length} {dropped.length === 1 ? 'rule' : 'rules'} dropped
          </strong>
          {dropped.map((error) => (
            <p key={error}>{error}</p>
          ))}
        </div>
      )}
    </article>
  );
}
