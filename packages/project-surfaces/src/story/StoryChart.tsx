import { Download } from 'lucide-react';
import { useMemo, useRef } from 'react';
import { displayDecimal, useAppTranslation } from '../lib/i18n';
import { type buildSessionStory, STORY_COLORS, type StoryEvent } from './session-story';

export function storyTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds >= 3600
    ? `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
    : seconds >= 60
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${seconds}s`;
}
export function StoryChart({
  story,
  end,
  cursor,
  selected,
  onSelect,
  actor,
}: {
  story: ReturnType<typeof buildSessionStory>;
  end: number;
  cursor: number;
  selected: string | null;
  onSelect(event: StoryEvent): void;
  actor: string;
}) {
  const { t } = useAppTranslation();
  const svg = useRef<SVGSVGElement>(null);
  const lanes =
    actor === 'all' ? story.actors.slice(0, 32) : story.actors.filter((lane) => lane.id === actor);
  const width = 1100;
  const left = 205;
  const right = 30;
  const row = 44;
  const height = lanes.length * row + 72;
  const span = Math.max(1, end - story.start);
  const x = (at: number) =>
    left + Math.max(0, Math.min(1, (at - story.start) / span)) * (width - left - right);
  const points = useMemo(() => {
    const stride = Math.max(1, Math.ceil(story.events.length / 1000));
    return story.events.filter((_, index) => index % stride === 0);
  }, [story.events]);
  const exportSVG = () => {
    if (!svg.current) return;
    const blob = new Blob([svg.current.outerHTML], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'session-story.svg';
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-2 p-4">
        <div>
          <h2 className="font-semibold">{t('activity:story.parallelLanes')}</h2>
          <p className="text-xs text-muted-foreground">{t('activity:story.parallelSubtitle')}</p>
        </div>
        <button
          type="button"
          onClick={exportSVG}
          className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs"
        >
          <Download size={13} /> SVG
        </button>
      </header>
      <div className="max-h-[420px] overflow-auto">
        <svg
          ref={svg}
          xmlns="http://www.w3.org/2000/svg"
          viewBox={`0 0 ${width} ${height}`}
          className="w-full min-w-[800px]"
          role="img"
          aria-label={t('activity:story.timelineLabel')}
        >
          <rect width={width} height={height} fill="hsl(var(--muted))" />
          {Array.from({ length: 6 }, (_, index) => {
            const at = story.start + (span * index) / 5;
            return (
              <g key={index}>
                <line
                  x1={x(at)}
                  x2={x(at)}
                  y1={32}
                  y2={height - 28}
                  stroke="hsl(var(--card))"
                  strokeDasharray="3 5"
                />
                <text
                  x={x(at)}
                  y={20}
                  textAnchor="middle"
                  fill="hsl(var(--muted-foreground))"
                  fontSize={10}
                >
                  {storyTime(at - story.start)}
                </text>
              </g>
            );
          })}
          {lanes.map((lane, index) => {
            const y = 55 + index * row;
            const parent = lanes.findIndex((candidate) => candidate.id === lane.parent);
            return (
              <g key={lane.id} opacity={lane.start <= cursor ? 1 : 0.3}>
                <rect
                  x={0}
                  y={y - 19}
                  width={width}
                  height={row}
                  fill={index % 2 ? 'hsl(var(--card))' : 'hsl(var(--muted))'}
                />
                {Array.from({ length: 6 }, (_, tick) => (
                  <line
                    key={tick}
                    x1={x(story.start + (span * tick) / 5)}
                    x2={x(story.start + (span * tick) / 5)}
                    y1={y - 18}
                    y2={y + 22}
                    stroke="hsl(var(--card))"
                    strokeDasharray="3 5"
                  />
                ))}
                {parent >= 0 && (
                  <path
                    d={`M 12 ${55 + parent * row} V ${y - 9} Q 12 ${y} 24 ${y} H 30`}
                    fill="none"
                    stroke="hsl(var(--muted-foreground))"
                    strokeDasharray="3 3"
                  />
                )}
                <text x={lane.parent ? 32 : 16} y={y} fill="hsl(var(--foreground))" fontSize={11}>
                  {lane.name.slice(0, 24)}
                  <title>
                    {lane.name} · {t('activity:story.events', { count: lane.events })} ·{' '}
                    {lane.status ?? t('activity:story.statusRecorded')}
                  </title>
                </text>
                <text x={16} y={y + 14} fill="hsl(var(--muted-foreground))" fontSize={9}>
                  {lane.status ?? t('activity:story.statusRecorded')} ·{' '}
                  {t('activity:story.events', { count: lane.events })}
                </text>
                {lane.start <= cursor && (
                  <line
                    x1={x(lane.start)}
                    x2={x(Math.min(cursor, lane.status === 'running' ? end : lane.end))}
                    y1={y}
                    y2={y}
                    stroke="hsl(var(--destructive))"
                    strokeOpacity={0.28}
                    strokeWidth={7}
                    strokeLinecap="round"
                  />
                )}
                {points
                  .filter((event) => event.actor === lane.id && event.at <= cursor)
                  .map((event) => (
                    // biome-ignore lint/a11y/useSemanticElements: SVG has no native button; markers support keyboard input and the event list provides equivalent HTML buttons.
                    <g
                      key={event.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`${lane.name}: ${event.title}`}
                      onClick={() => onSelect(event)}
                      onKeyDown={(key) => {
                        if (key.key === 'Enter' || key.key === ' ') {
                          key.preventDefault();
                          onSelect(event);
                        }
                      }}
                      style={{ cursor: 'pointer' }}
                    >
                      {selected === event.id && (
                        <circle
                          cx={x(event.at)}
                          cy={y}
                          r={9}
                          fill="none"
                          stroke={STORY_COLORS[event.kind]}
                          className="story-halo"
                        />
                      )}
                      <circle
                        className="story-marker"
                        cx={x(event.at)}
                        cy={y}
                        r={selected === event.id ? 6 : 3.5}
                        fill={STORY_COLORS[event.kind]}
                        stroke={
                          selected === event.id
                            ? 'hsl(var(--foreground))'
                            : 'hsl(var(--background))'
                        }
                        strokeWidth={1.5}
                      />
                      <title>
                        {event.title} · +{storyTime(event.at - story.start)}
                        {event.durationMs !== undefined
                          ? ` · ${displayDecimal(event.durationMs, 0)}ms`
                          : ''}
                      </title>
                    </g>
                  ))}
              </g>
            );
          })}
          <line
            className="story-cursor"
            x1={x(cursor)}
            x2={x(cursor)}
            y1={32}
            y2={height - 22}
            stroke="hsl(var(--foreground))"
            strokeOpacity={0.6}
            strokeDasharray="4 4"
          />
        </svg>
      </div>
      {(story.actors.length > lanes.length || story.events.length > points.length) && (
        <p className="p-3 text-xs text-muted-foreground">
          {t('activity:story.chartSampling', { lanes: lanes.length })}
        </p>
      )}
    </section>
  );
}

export function ActivityPulse({
  story,
  end,
}: {
  story: ReturnType<typeof buildSessionStory>;
  end: number;
}) {
  const { t } = useAppTranslation();
  const bins = Array.from({ length: 36 }, () =>
    Object.fromEntries(Object.keys(STORY_COLORS).map((kind) => [kind, 0])),
  );
  const span = Math.max(1, end - story.start);
  for (const event of story.events)
    bins[Math.min(35, Math.max(0, Math.floor(((event.at - story.start) / span) * 36)))]![
      event.kind
    ]!++;
  const max = Math.max(
    1,
    ...bins.map((bin) => Object.values(bin).reduce((sum, value) => sum + value, 0)),
  );
  return (
    <section className="rounded-2xl border bg-card p-4">
      <div className="mb-4 flex justify-between">
        <h2 className="font-semibold">{t('activity:story.sessionPulse')}</h2>
        <span className="text-xs text-muted-foreground">{t('activity:story.pulseSubtitle')}</span>
      </div>
      <div
        className="flex h-20 items-end gap-1"
        role="img"
        aria-label={t('activity:story.densityLabel')}
      >
        {bins.map((bin, index) => (
          <div
            key={index}
            className="story-bar flex min-w-0 flex-1 flex-col-reverse overflow-hidden rounded-t"
            style={{
              height: `${Math.max(2, (Object.values(bin).reduce((sum, value) => sum + value, 0) / max) * 100)}%`,
            }}
            title={t('activity:story.bucketTitle', {
              offset: storyTime((span * index) / 36),
              count: Object.values(bin).reduce((sum, value) => sum + value, 0),
            })}
          >
            {Object.entries(bin).map(([kind, count]) =>
              count > 0 ? (
                <span
                  key={kind}
                  style={{
                    background: STORY_COLORS[kind as keyof typeof STORY_COLORS],
                    flex: count,
                  }}
                />
              ) : null,
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
        <span>+0s</span>
        <span>+{storyTime(span)}</span>
      </div>
    </section>
  );
}
