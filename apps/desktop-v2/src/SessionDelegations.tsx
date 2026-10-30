import { Users } from 'lucide-react';
import { type DelegationRecord, delegationTotals } from './delegations';

const seconds = (ms: number) =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
const usd = (value: number) => `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;

/**
 * Worker agents this conversation delegated to, as the engine reported each one when it
 * finished, with the engine's own cost estimate where it had one.
 */
export function SessionDelegations({ delegations }: { delegations: DelegationRecord[] }) {
  if (!delegations.length) return null;
  const totals = delegationTotals(delegations);
  return (
    <section className="session-delegations" aria-label="Worker delegations">
      <header>
        <Users size={15} />
        <h3>Worker delegations</h3>
      </header>
      <p className="settings-defaults-note">
        {totals.count} finished · {totals.failed} not successful · {totals.toolCalls} tool calls ·{' '}
        {seconds(totals.durationMs)}
        {totals.costUsd === null ? '' : ` · estimated ${usd(totals.costUsd)}`}
        {totals.unpriced ? ` · ${totals.unpriced} without a cost estimate` : ''}. As reported when
        each delegation finished; worker tokens are counted by the workers, not in the conversation
        counters above.
      </p>
      <ol aria-label="Finished delegations">
        {delegations
          .slice()
          .reverse()
          .map((item) => (
            <li key={item.id} className={item.ok ? '' : 'failed'}>
              <strong>{item.target}</strong>
              <span>
                {item.ok ? 'Succeeded' : `Did not succeed${item.status ? ` (${item.status})` : ''}`}{' '}
                · {item.iterations} turns · {item.toolCalls} tool calls · {seconds(item.durationMs)}
                {item.costUsd === null ? '' : ` · ${usd(item.costUsd)}`}
              </span>
              {item.summary && <small>{item.summary}</small>}
            </li>
          ))}
      </ol>
    </section>
  );
}
