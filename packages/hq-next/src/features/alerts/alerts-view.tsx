'use client';

/**
 * Alert history — what HQ's alert rules caught, and for how long.
 *
 * Rules still firing come first, with how long they have been firing. Below,
 * every episode in the loaded history, filterable by rule (`?rule=`), grouped
 * by day. Decisions waiting on a person are in the Queue tab, not here.
 */
import { fetchAlertSettings, fetchJson } from '@hq/data/api';
import { useHqStore } from '@hq/data/store/index';
import type { HqAlert } from '@wrongstack/hq';
import { ArrowRight, BellOff } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { relativeTime } from '@/features/attention/model';
import { plural } from '@/features/overview/model';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/error-text';
import { duration, type Episode, episodes, RULE_LABEL, ruleCounts, ruleName } from './model';
import { MuteControls } from './mute-controls';

const POLL_MS = 15_000;
const HISTORY_LIMIT = 500;
const NOTICE_LIMIT = 30;

const SEVERITY: Record<string, { label: string; tone: string; border: string }> = {
  error: { label: 'Error', tone: 'text-destructive', border: 'border-destructive/60' },
  warn: { label: 'Warning', tone: 'text-warning', border: 'border-warning/60' },
  info: { label: 'Info', tone: 'text-muted-foreground', border: 'border-border' },
};

function dayOf(at: number): string {
  const date = new Date(at);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}

export function AlertsView(): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const notices = useHqStore((state) => state.alerts);
  const [data, setData] = useState<{ active: HqAlert[]; history: HqAlert[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [snoozes, setSnoozes] = useState<Record<string, number>>({});

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await fetchJson<{ active: HqAlert[]; history: HqAlert[] }>(
        `/api/alerts?limit=${HISTORY_LIMIT}`,
      );
      setData({ active: next.active ?? [], history: next.history ?? [] });
      setError(null);
      // Mutes are a convenience on top of the history: a failure here
      // leaves the list readable.
      setSnoozes((await fetchAlertSettings().catch(() => null))?.snoozes ?? {});
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setNow(Date.now());
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const all = useMemo(() => (data === null ? [] : episodes(data.active, data.history)), [data]);
  const rules = useMemo(() => ruleCounts(all), [all]);
  const rule = params.get('rule');
  const firing = all.filter((episode) => episode.active);
  const past = all.filter(
    (episode) => !episode.active && (rule === null || episode.alert.ruleId === rule),
  );
  const days = useMemo(() => {
    const groups: { day: string; items: Episode[] }[] = [];
    for (const episode of past) {
      const day = dayOf(episode.alert.firstFiredAt);
      const last = groups.at(-1);
      if (last?.day === day) last.items.push(episode);
      else groups.push({ day, items: [episode] });
    }
    return groups;
  }, [past]);
  const recentNotices = notices.slice(-NOTICE_LIMIT).reverse();

  const pick = (ruleId: string | null): void => {
    router.replace(ruleId === null ? pathname : `${pathname}?rule=${encodeURIComponent(ruleId)}`, {
      scroll: false,
    });
  };

  if (data === null) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16">
        <p
          className={cn('text-base', error !== null ? 'text-destructive' : 'text-muted-foreground')}
        >
          {error !== null
            ? `The alert history could not be read: ${error}`
            : 'Reading the alert history…'}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-6">
      <header className="flex flex-col gap-2">
        <h2 className="font-display text-2xl font-semibold">
          {firing.length > 0
            ? `${plural(firing.length, 'rule')} firing now`
            : 'No alert rule is firing'}
        </h2>
        <p className="text-base text-muted-foreground">
          {all.length === 0
            ? 'No rule has fired since HQ started keeping history.'
            : `${plural(all.length, 'episode')} in the history across ${plural(rules.length, 'rule')}.`}{' '}
          <Link
            href="/inbox/"
            className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
          >
            Decisions waiting on you are in the Queue <ArrowRight className="size-3.5" />
          </Link>
        </p>
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            The last refresh failed: {error}. Showing what was loaded before.
          </p>
        )}
      </header>

      {firing.length > 0 && (
        <section aria-labelledby="alerts-firing" className="flex flex-col gap-3">
          <h3 id="alerts-firing" className="text-sm font-semibold">
            Firing now
          </h3>
          <ul className="flex flex-col gap-2">
            {firing.map((episode) => {
              const severity = SEVERITY[episode.alert.severity] ?? SEVERITY.info;
              return (
                <li
                  key={episode.alert.id}
                  data-alert={episode.alert.ruleId}
                  className={cn('flex flex-col gap-1.5 border bg-card px-4 py-3', severity?.border)}
                >
                  <p className="flex flex-wrap items-baseline gap-x-3 text-sm">
                    <span className={cn('font-semibold', severity?.tone)}>{severity?.label}</span>
                    <span className="font-medium">{ruleName(episode.alert.ruleId)}</span>
                    <span className="ml-auto text-muted-foreground">
                      firing for {duration(now - episode.alert.firstFiredAt)}
                    </span>
                  </p>
                  <p className="text-base">{episode.alert.message}</p>
                  <p className="text-xs text-muted-foreground">
                    Since {new Date(episode.alert.firstFiredAt).toLocaleString()} · last confirmed{' '}
                    {relativeTime(episode.alert.lastFiredAt, now)}
                    {RULE_LABEL[episode.alert.ruleId] !== undefined &&
                      ` · ${RULE_LABEL[episode.alert.ruleId]?.checks}`}
                  </p>
                  <MuteControls
                    ruleId={episode.alert.ruleId}
                    until={snoozes[episode.alert.ruleId]}
                    now={now}
                    onChanged={load}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {rules.length > 0 && (
        <fieldset className="flex flex-wrap gap-2">
          <legend className="mb-2 text-sm font-semibold">History</legend>
          {[
            {
              ruleId: null as string | null,
              label: 'Every rule',
              count: all.filter((e) => !e.active).length,
            },
          ]
            .concat(
              rules.map((entry) => ({
                ruleId: entry.ruleId,
                label: ruleName(entry.ruleId),
                count: all.filter((e) => !e.active && e.alert.ruleId === entry.ruleId).length,
              })),
            )
            .filter((option) => option.ruleId === null || option.count > 0)
            .map((option) => (
              <label
                key={option.ruleId ?? 'all'}
                className={cn(
                  'flex h-9 cursor-pointer items-center gap-2 border px-3 text-sm focus-within:ring-2 focus-within:ring-ring',
                  option.ruleId === rule
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                <input
                  type="radio"
                  name="alert-rule"
                  checked={option.ruleId === rule}
                  onChange={() => pick(option.ruleId)}
                  className="sr-only"
                />
                {option.label}
                <span className="tabular">{option.count}</span>
              </label>
            ))}
        </fieldset>
      )}

      {days.length === 0
        ? all.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {rule === null
                ? 'Every episode in the history is still firing.'
                : 'This rule has no finished episode in the loaded history.'}
            </p>
          )
        : days.map((group) => (
            <section key={group.day} className="flex flex-col">
              <h3 className="border-b border-border py-2 text-sm font-semibold">{group.day}</h3>
              <ol className="flex flex-col">
                {group.items.map((episode) => {
                  const severity = SEVERITY[episode.alert.severity] ?? SEVERITY.info;
                  return (
                    <li
                      key={episode.alert.id}
                      data-episode={episode.alert.ruleId}
                      className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-0.5 border-b border-border py-3"
                    >
                      <span className="tabular text-sm text-muted-foreground">
                        {new Date(episode.alert.firstFiredAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                      <span className="flex flex-wrap items-baseline gap-x-3 text-sm">
                        <span className={cn('font-medium', severity?.tone)}>
                          {ruleName(episode.alert.ruleId)}
                        </span>
                        <span className="text-muted-foreground">
                          {episode.durationMs > 0
                            ? `fired for ${duration(episode.durationMs)}`
                            : 'seen once'}
                        </span>
                      </span>
                      <span />
                      <span className="text-sm">{episode.alert.message}</span>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}

      {all.length === 0 && (
        <p className="flex items-center gap-2 text-base text-muted-foreground">
          <BellOff className="size-4" /> Nothing has fired yet.
        </p>
      )}

      {recentNotices.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            {plural(recentNotices.length, 'notice')} from this HQ since the page opened
          </summary>
          <ol className="mt-2 flex flex-col">
            {recentNotices.map((notice, index) => (
              <li
                key={`${notice.timestamp}-${index}`}
                className="flex gap-3 border-t border-border py-2"
              >
                <span className="tabular shrink-0 text-muted-foreground">
                  {new Date(notice.timestamp).toLocaleTimeString()}
                </span>
                <span className={cn('shrink-0', SEVERITY[notice.severity]?.tone)}>
                  {SEVERITY[notice.severity]?.label ?? notice.severity}
                </span>
                <span className="min-w-0 break-words">{notice.message}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
