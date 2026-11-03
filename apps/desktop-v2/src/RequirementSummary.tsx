import { CopyButton } from './CopyButton';
import { isVibeIntake, readable, strings, text } from './requirement-values';

/** A requirement's original request, summary, recorded fields and lists. */
export function RequirementSummary({ detail }: { detail: Record<string, unknown> }) {
  const original = text(detail['originalRequest']);
  const summary = text(detail['normalizedSummary']);
  return (
    <>
      <h4 className="requirement-original-heading">
        Original request <CopyButton text={original} label="Copy the original request" />
      </h4>
      <p className="requirement-original">{original}</p>
      {summary && summary !== original && (
        <>
          <h4>Summary</h4>
          <p>{summary}</p>
        </>
      )}
      <dl className="requirement-metadata">
        {[
          ['Business goal', text(detail['businessGoal'])],
          ['Expected outcome', text(detail['expectedOutcome'])],
          ['Scope', text(detail['scopeNotes'])],
          ['Requested by', text(detail['requestedBy'])],
          ['Priority', readable(detail['priority'])],
          ['Protocol', isVibeIntake(detail) ? 'VIBE three-stage verification' : 'Standard'],
        ].map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value || 'Not recorded'}</dd>
          </div>
        ))}
      </dl>
      {[
        ['Target users', detail['targetUsers']],
        ['Constraints', detail['constraints']],
        ['Provided context', detail['providedContext']],
      ].map(
        ([name, value]) =>
          strings(value).length > 0 && (
            <div key={String(name)}>
              <h4>{String(name)}</h4>
              <ul>
                {strings(value).map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          ),
      )}
    </>
  );
}
