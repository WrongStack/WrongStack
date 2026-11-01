'use client';

/**
 * A machine's health from the newest sample its clients sent: memory, the
 * disk that holds the project, CPU load, uptime and WrongStack's own memory,
 * with meters and the age of the reading.
 */
import type { ReactNode } from 'react';
import { relativeTime } from '@/features/attention/model';
import { cn } from '@/lib/cn';
import { healthFacts, isFresh, platformLabel } from './health';
import type { MachineSummary } from './model';

export function HealthBlock({ machine, now }: { machine: MachineSummary; now: number }): ReactNode {
  const health = machine.health;
  return (
    <div className="flex flex-col gap-2" data-testid="machine-health">
      <h4 className="text-sm font-semibold">
        Health
        {health !== undefined && (
          <span className="ml-2 font-normal text-muted-foreground">
            {platformLabel(health)} · read {relativeTime(health.reportedAt, now)}
            {!isFresh(health, now) && ' (not current)'}
          </span>
        )}
      </h4>
      {health === undefined ? (
        <p className="text-sm text-muted-foreground">
          No reading yet. Clients send one with their heartbeat, every half minute; clients older
          than this HQ release send none.
        </p>
      ) : (
        <dl className="grid gap-3 sm:grid-cols-2">
          {healthFacts(health, now).map((fact) => (
            <div key={fact.label} className="flex flex-col gap-1">
              <dt className="text-xs text-muted-foreground">{fact.label}</dt>
              <dd className={cn('tabular text-sm', fact.warn && 'font-semibold text-warning')}>
                {fact.value}
              </dd>
              {fact.used !== undefined && (
                <div aria-hidden className="h-1.5 w-full bg-muted">
                  <div
                    className={cn('h-full', fact.warn ? 'bg-warning' : 'bg-primary/70')}
                    style={{ width: `${Math.round(fact.used * 100)}%` }}
                  />
                </div>
              )}
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
