import { useState } from 'react';
import { displayDecimal, displayLocale, useAppTranslation } from '../lib/i18n';
import { distribution, type SessionModelStats } from './session-model-stats';
import type { StoryEvent } from './session-story';

const ms = (value: number | undefined) =>
  value === undefined
    ? '—'
    : value < 1000
      ? `${Math.round(value)} ms`
      : `${displayDecimal(value / 1000, 2)} s`;
const count = (value: number) => value.toLocaleString(displayLocale());
const usd = (value: number | undefined) =>
  value === undefined
    ? '—'
    : value > 0 && value < 0.000001
      ? '<$0.000001'
      : `$${displayDecimal(value, 6)}`;
const avgText = (value: number | undefined, digits: number) =>
  value === undefined ? '—' : displayDecimal(value, digits);
const ratio = (n: number, total: number) =>
  total ? `${displayDecimal((n / total) * 100, 1)}%` : '—';
const samples = (n: number, total: number) => `${n}/${total}`;
type Mode = 'reliability' | 'speed' | 'work';

export function ModelDashboard({
  models,
  onInspect,
}: {
  models: SessionModelStats[];
  onInspect(event: StoryEvent): void;
}) {
  const { t } = useAppTranslation();
  const [mode, setMode] = useState<Mode>('reliability');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string>('all');
  const [sort, setSort] = useState('attempts');
  const rows = models
    .filter((row) => `${row.model} ${row.provider}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) =>
      sort === 'failures'
        ? b.failed - a.failed
        : sort === 'latency'
          ? (distribution(b.durations).avg ?? -1) - (distribution(a.durations).avg ?? -1)
          : sort === 'cost'
            ? (b.pricedSamples ? b.cost : -1) - (a.pricedSamples ? a.cost : -1)
            : b.attempts - a.attempts,
    );
  const picked = models.find((row) => row.key === selected);
  const maxLatency = Math.max(1, ...rows.map((row) => distribution(row.durations).avg ?? 0));
  const evidence = picked?.evidence ?? [];
  const issues = evidence.filter(
    (event) =>
      event.kind === 'alert' ||
      event.raw?.outcome === 'failure' ||
      /intervention|loop|verification/.test(event.raw?.eventType ?? ''),
  );
  const headers =
    mode === 'reliability'
      ? [
          t('activity:story.mhModelProvider'),
          t('activity:story.mhAttempts'),
          t('activity:story.mhUsableFailedUnsettled'),
          t('activity:story.mhAttemptSuccess'),
          t('activity:story.mhLogicalRequests'),
          t('activity:story.mhRetryAttempts'),
          t('activity:story.mhRetryWait'),
          t('activity:story.mhRecovered'),
          t('activity:story.mhFallback'),
        ]
      : mode === 'speed'
        ? [
            t('activity:story.mhModelProvider'),
            t('activity:story.shAvg'),
            t('activity:story.shTimed'),
            t('activity:story.shFirstChunk'),
            t('activity:story.shFirstChunkSamples'),
            t('activity:story.shOutputTps'),
            t('activity:story.shFresh'),
            t('activity:story.shCacheTokens'),
            t('activity:story.shCacheHit'),
            t('activity:story.shUsageCoverage'),
            t('activity:story.shEstCost'),
          ]
        : [
            t('activity:story.mhModelProvider'),
            t('activity:story.whAgents'),
            t('activity:story.whTools'),
            t('activity:story.whToolOutcomes'),
            t('activity:story.whToolTiming'),
            t('activity:story.whToolCoverage'),
            t('activity:story.whInvalidInputs'),
            t('activity:story.whTasks'),
            t('activity:story.whVerification'),
            t('activity:story.whLoopsDrift'),
            t('activity:story.whLengthStops'),
          ];
  const cells = (row: SessionModelStats) => {
    const timing = distribution(row.durations),
      first = distribution(row.firstChunk),
      tools = distribution(row.toolDurations);
    return mode === 'reliability'
      ? [
          count(row.attempts),
          `${row.completed} / ${row.failed} / ${row.unsettled}`,
          ratio(row.completed, row.completed + row.failed),
          row.requests.size || '—',
          `${row.retryAttempts} / ${row.retryScheduleSamples ? row.retriesScheduled : '—'} (${samples(row.retryScheduleSamples, row.failed)})`,
          row.retryDelaySamples
            ? `${ms(row.retryDelay)} (${samples(row.retryDelaySamples, row.retriesScheduled)})`
            : '—',
          row.recovered,
          `${row.fallbackOut} / ${row.fallbackIn}`,
        ]
      : mode === 'speed'
        ? [
            `${ms(timing.avg)} / ${ms(timing.p50)} / ${ms(timing.p95)} / ${ms(timing.max)}`,
            samples(timing.n, row.attempts),
            `${ms(first.avg)} / ${ms(first.p95)}`,
            first.n,
            row.timedOutputMs
              ? displayDecimal(row.timedOutput / (row.timedOutputMs / 1000), 1)
              : '—',
            row.usageSamples ? `${count(row.input)} / ${count(row.output)}` : '—',
            row.usageSamples ? `${count(row.cacheRead)} / ${count(row.cacheWrite)}` : '—',
            ratio(row.cacheRead, row.input + row.cacheRead + row.cacheWrite),
            `${row.usageSamples}${row.usageSource === 'attempts' ? `/${row.completed}` : ''} (${row.usageSource})`,
            `${usd(row.pricedSamples ? row.cost : undefined)} · ${samples(row.pricedSamples, row.accountingSamples)}`,
          ]
        : [
            row.agents.size,
            `${row.toolCalls} / ${row.toolUnsettled}`,
            `${row.toolSuccess} / ${row.toolFailed} / ${row.toolBlocked}`,
            `${ms(tools.avg)} / ${ms(tools.p95)}`,
            samples(tools.n, row.toolCalls),
            row.invalidInputs,
            `${row.taskSuccess} / ${row.taskFailed} / ${row.taskTimeout} / ${row.taskStopped} / ${row.taskUnknown}`,
            row.verificationFailed,
            `${row.loops} / ${row.drift} / ${row.interventions}`,
            Object.entries(row.stopReasons)
              .filter(([key]) => /length|max_tokens/.test(key))
              .reduce((sum, [, n]) => sum + n, 0),
          ];
  };
  return (
    <div className="story-enter space-y-5">
      <section className="rounded-2xl border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-semibold">{t('activity:story.modelPerformance')}</h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
              {t('activity:story.modelSubtitle')}
            </p>
          </div>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label={t('activity:story.searchModelsLabel')}
            placeholder={t('activity:story.searchModelsPlaceholder')}
            className="rounded-xl border bg-background px-3 py-2 text-sm"
          />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {(['reliability', 'speed', 'work'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
              className={`rounded-xl border px-3 py-2 text-xs ${mode === value ? 'border-info/50 bg-info/10 text-info' : ''}`}
            >
              {value === 'reliability'
                ? t('activity:story.modeReliability')
                : value === 'speed'
                  ? t('activity:story.modeSpeed')
                  : t('activity:story.modeWork')}
            </button>
          ))}
          <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            {t('activity:story.sortLabel')}
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value)}
              className="rounded-lg border bg-background px-2 py-1"
            >
              <option value="attempts">{t('activity:story.sortAttempts')}</option>
              <option value="failures">{t('activity:story.sortFailures')}</option>
              <option value="latency">{t('activity:story.sortLatency')}</option>
              <option value="cost">{t('activity:story.sortCost')}</option>
            </select>
          </label>
        </div>
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <section className="rounded-xl border bg-background/40 p-4">
            <h3 className="text-sm font-medium">{t('activity:story.attemptReliability')}</h3>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t('activity:story.reliabilityLegend')}
            </p>
            <div className="mt-4 space-y-3">
              {rows.slice(0, 8).map((row) => (
                <button
                  key={row.key}
                  type="button"
                  onClick={() => setSelected(row.key)}
                  className="block w-full text-left"
                >
                  <span className="mb-1 flex justify-between gap-2 text-xs">
                    <span className="truncate">
                      {row.model}
                      <span className="ml-2 text-muted-foreground">{row.provider}</span>
                    </span>
                    <span className="shrink-0 font-mono">
                      {ratio(row.completed, row.completed + row.failed)} · n=
                      {row.completed + row.failed}
                    </span>
                  </span>
                  <span className="flex h-2.5 overflow-hidden rounded-full bg-muted">
                    {[
                      [row.completed, 'hsl(var(--success))'],
                      [row.failed, 'hsl(var(--destructive))'],
                      [row.unsettled, 'hsl(var(--muted-foreground))'],
                    ].map(([n, color]) =>
                      Number(n) > 0 ? (
                        <span
                          key={color}
                          className="story-meter"
                          style={{
                            width: `${(Number(n) / Math.max(1, row.attempts)) * 100}%`,
                            background: String(color),
                          }}
                        />
                      ) : null,
                    )}
                  </span>
                </button>
              ))}
            </div>
          </section>
          <section className="rounded-xl border bg-background/40 p-4">
            <h3 className="text-sm font-medium">{t('activity:story.measuredLatency')}</h3>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t('activity:story.latencySubtitle')}
            </p>
            <div className="mt-4 space-y-3">
              {rows.slice(0, 8).map((row) => {
                const timing = distribution(row.durations);
                return (
                  <button
                    key={row.key}
                    type="button"
                    onClick={() => setSelected(row.key)}
                    className="block w-full text-left"
                  >
                    <span className="mb-1 flex justify-between gap-2 text-xs">
                      <span className="truncate">{row.model}</span>
                      <span className="shrink-0 font-mono">
                        {ms(timing.avg)} · n={timing.n}
                      </span>
                    </span>
                    <span className="block h-2.5 overflow-hidden rounded-full bg-muted">
                      <span
                        className="story-meter block h-full rounded-full bg-primary"
                        style={{ width: `${((timing.avg ?? 0) / maxLatency) * 100}%` }}
                      />
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                {headers.map((header) => (
                  <th key={header} className="whitespace-nowrap px-3 py-3 font-medium">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.key}
                  className={`border-t ${selected === row.key ? 'bg-info/5' : 'hover:bg-muted/30'}`}
                >
                  <td className="min-w-48 px-3 py-3">
                    <button
                      type="button"
                      onClick={() => setSelected(row.key)}
                      aria-pressed={selected === row.key}
                      className="text-left font-medium text-info underline"
                    >
                      {row.model}
                    </button>
                    <p className="mt-1 text-[11px] text-muted-foreground">{row.provider}</p>
                  </td>
                  {cells(row).map((cell, index) => (
                    <td key={index} className="whitespace-nowrap px-3 py-3 font-mono">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t('activity:story.noModelMatches')}
          </p>
        )}
        <p className="mt-4 text-[11px] leading-5 text-muted-foreground">
          {t('activity:story.modelFootnote')}
        </p>
      </section>
      {picked && (
        <section className="rounded-2xl border bg-card p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold">
                {picked.model} · {picked.provider}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('activity:story.modelDetailCounts', {
                  lanes: picked.agents.size,
                  diagnostics: issues.length,
                  supporting: picked.evidence.length,
                })}
              </p>
            </div>
            <button type="button" onClick={() => setSelected('all')} className="text-xs underline">
              {t('activity:story.closeDetails')}
            </button>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              [
                t('activity:story.statPrompt'),
                `${avgText(distribution(picked.promptTokens).avg, 0)} / ${distribution(picked.promptTokens).max ?? '—'}`,
                t('activity:story.notePromptTokens', { count: picked.promptTokens.length }),
              ],
              [
                t('activity:story.statResponse'),
                `${avgText(distribution(picked.responseTokens).avg, 0)} / ${distribution(picked.responseTokens).p95 ?? '—'}`,
                t('activity:story.noteSamples', { count: picked.responseTokens.length }),
              ],
              [
                t('activity:story.statMessages'),
                `${avgText(distribution(picked.messageCounts).avg, 1)} / ${avgText(distribution(picked.offeredTools).avg, 1)}`,
                t('activity:story.noteSamplePairs', {
                  messages: picked.messageCounts.length,
                  tools: picked.offeredTools.length,
                }),
              ],
              [
                t('activity:story.statStreaming'),
                `${samples(picked.streamingAttempts, picked.streamingSamples)} / ${usd(picked.pricedSamples ? picked.cost / picked.pricedSamples : undefined)}`,
                t('activity:story.notePricedCalls', { count: picked.pricedSamples }),
              ],
            ].map(([label, value, note]) => (
              <div key={label} className="rounded-xl border p-3">
                <h3 className="text-[11px] text-muted-foreground">{label}</h3>
                <p className="mt-2 font-mono text-sm">{value}</p>
                <p className="mt-2 text-[10px] text-muted-foreground">{note}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {[
              [t('activity:story.failureKinds'), picked.errorKinds],
              [t('activity:story.httpStatuses'), picked.httpStatuses],
              [t('activity:story.stopReasons'), picked.stopReasons],
            ].map(([label, values]) => (
              <section key={String(label)} className="rounded-xl bg-muted/30 p-3">
                <h3 className="text-xs font-medium">{String(label)}</h3>
                <p className="mt-2 break-words font-mono text-xs text-muted-foreground">
                  {Object.entries(values as Record<string, number>)
                    .map(([key, n]) => `${key}: ${n}`)
                    .join(' · ') || t('activity:story.noSamples')}
                </p>
              </section>
            ))}
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            {t('activity:story.modelEvidenceNote')}
          </p>
          <div className="mt-4 space-y-2">
            {(issues.length ? issues : evidence)
              .slice(-20)
              .reverse()
              .map((event) => (
                <button
                  key={event.id}
                  type="button"
                  onClick={() => onInspect(event)}
                  className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-3 py-2 text-left text-xs hover:bg-muted/30"
                >
                  <span className="text-muted-foreground">
                    {new Date(event.at).toLocaleTimeString(displayLocale())}
                  </span>
                  <span className="font-medium">{event.raw?.eventType}</span>
                  <span className="ml-auto font-mono text-muted-foreground">
                    {t('activity:story.statusRecorded')} · {event.actor}
                  </span>
                </button>
              ))}
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            {t('activity:story.diagnosticNote')}
          </p>
        </section>
      )}
    </div>
  );
}
