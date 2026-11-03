import type { CSSProperties } from 'react';
import { useId } from 'react';
import { useAppTranslation } from '../lib/i18n';
import { storyTime } from './StoryChart';
import { type buildSessionStory, STORY_COLORS, type StoryKind } from './session-story';

const KIND_KEYS = {
  model: 'activity:story.kindModel',
  tool: 'activity:story.kindTool',
  file: 'activity:story.kindFile',
  memory: 'activity:story.kindMemory',
  agent: 'activity:story.kindAgent',
  mail: 'activity:story.kindMail',
  alert: 'activity:story.kindAlert',
  session: 'activity:story.kindSession',
  work: 'activity:story.kindWork',
} as const;

type Story = ReturnType<typeof buildSessionStory>;

/** Sweep observed intervals; gaps and zero-length observations never imply active work. */
export function observedOverlap(story: Story) {
  const changes = new Map<number, number>();
  for (const actor of story.actors) {
    if (actor.end <= actor.start) continue;
    changes.set(actor.start, (changes.get(actor.start) ?? 0) + 1);
    changes.set(actor.end, (changes.get(actor.end) ?? 0) - 1);
  }
  let active = 0;
  let peak = 0;
  const points = [...changes]
    .sort(([a], [b]) => a - b)
    .map(([at, delta]) => {
      const before = active;
      active += delta;
      peak = Math.max(peak, active);
      return { at, before, active };
    });
  return { points, peak };
}

export function StoryInsights({
  story,
  end,
  cursor,
  kind,
  onKind,
}: {
  story: Story;
  end: number;
  cursor: number;
  kind: StoryKind | 'all';
  onKind(value: StoryKind | 'all'): void;
}) {
  const { t } = useAppTranslation();
  const gradient = useId().replace(/:/g, '');
  const total = story.events.length;
  let offset = 0;
  const categories = (Object.keys(STORY_COLORS) as StoryKind[]).filter(
    (key) => story.counts[key] > 0,
  );
  const overlap = observedOverlap(story);
  const x = (at: number) => 20 + ((at - story.start) / Math.max(1, end - story.start)) * 460;
  const y = (value: number) => 140 - (value / Math.max(1, overlap.peak)) * 105;
  const path = `M 20 140 ${overlap.points.map((point) => `H ${x(point.at)} V ${y(point.active)}`).join(' ')} H 480 V 140 Z`;
  const busiest = [...story.actors].sort((a, b) => b.events - a.events).slice(0, 5);
  const maxEvents = Math.max(1, ...busiest.map((actor) => actor.events));
  return (
    <div className="story-enter grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <section className="story-card rounded-2xl border bg-card p-5">
        <h2 className="font-semibold">{t('activity:story.activitySpectrum')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('activity:story.spectrumSubtitle')}</p>
        <div className="flex flex-wrap items-center justify-center gap-5 pt-5">
          <svg
            viewBox="0 0 180 180"
            className="w-40 shrink-0"
            role="img"
            aria-label={t('activity:story.spectrumLabel')}
          >
            <circle
              cx="90"
              cy="90"
              r="66"
              fill="none"
              stroke="hsl(var(--muted-foreground) / 0.14)"
              strokeWidth="16"
            />
            {categories.map((category) => {
              const amount = (story.counts[category] / Math.max(1, total)) * 100;
              const start = offset;
              offset += amount;
              return (
                <circle
                  key={category}
                  cx="90"
                  cy="90"
                  r="66"
                  pathLength="100"
                  fill="none"
                  stroke={STORY_COLORS[category]}
                  strokeWidth={kind === category ? 22 : 16}
                  strokeDasharray={`${amount} ${100 - amount}`}
                  strokeDashoffset={-start}
                  transform="rotate(-90 90 90)"
                  className="story-draw"
                  style={
                    {
                      '--story-dash': `${amount} ${100 - amount}`,
                      opacity: kind === 'all' || kind === category ? 1 : 0.25,
                    } as CSSProperties
                  }
                >
                  <title>
                    {t('activity:story.categoryTitle', {
                      category: t(KIND_KEYS[category]),
                      count: story.counts[category],
                      percent: Math.round(amount),
                    })}
                  </title>
                </circle>
              );
            })}
            <text
              x="90"
              y="88"
              textAnchor="middle"
              fill="currentColor"
              fontSize="28"
              fontWeight="600"
            >
              {total.toLocaleString()}
            </text>
            <text
              x="90"
              y="108"
              textAnchor="middle"
              fill="hsl(var(--muted-foreground))"
              fontSize="10"
            >
              {t('activity:story.loadedEvents')}
            </text>
          </svg>
          <div className="min-w-[130px] flex-1 space-y-1">
            {categories.map((category) => (
              <button
                type="button"
                key={category}
                aria-pressed={kind === category}
                onClick={() => onKind(kind === category ? 'all' : category)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-muted/50"
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: STORY_COLORS[category] }}
                />
                <span className="capitalize">{t(KIND_KEYS[category])}</span>
                <span className="ml-auto font-mono">{story.counts[category]}</span>
              </button>
            ))}
          </div>
        </div>
      </section>
      <section className="story-card rounded-2xl border bg-card p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">{t('activity:story.teamOverlap')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('activity:story.overlapSubtitle')}
            </p>
          </div>
          <span className="text-3xl font-semibold text-info">
            {overlap.peak}
            <span className="ml-1 text-xs text-muted-foreground">{t('activity:story.peak')}</span>
          </span>
        </div>
        <svg
          viewBox="0 0 500 170"
          className="mt-5 w-full"
          role="img"
          aria-label={t('activity:story.overlapLabel')}
        >
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(var(--info))" stopOpacity=".5" />
              <stop offset="100%" stopColor="hsl(var(--info))" stopOpacity=".02" />
            </linearGradient>
          </defs>
          {[0, 1, 2, 3].map((tick) => (
            <line
              key={tick}
              x1="20"
              x2="480"
              y1={35 + tick * 35}
              y2={35 + tick * 35}
              stroke="hsl(var(--muted-foreground) / 0.2)"
              strokeDasharray="3 5"
            />
          ))}
          <path d={path} fill={`url(#${gradient})`} stroke="hsl(var(--info))" strokeWidth="2" />
          <line
            x1={x(cursor)}
            x2={x(cursor)}
            y1="25"
            y2="140"
            stroke="hsl(var(--destructive))"
            strokeDasharray="4 4"
            className="story-cursor"
          />
          <text x="20" y="163" fill="hsl(var(--muted-foreground))" fontSize="10">
            +0s
          </text>
          <text x="480" y="163" textAnchor="end" fill="hsl(var(--muted-foreground))" fontSize="10">
            +{storyTime(end - story.start)}
          </text>
        </svg>
        <p className="mt-2 text-[11px] text-muted-foreground">{t('activity:story.overlapNote')}</p>
      </section>
      <section className="story-card rounded-2xl border bg-card p-5 md:col-span-2 xl:col-span-1">
        <h2 className="font-semibold">{t('activity:story.teamActivity')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('activity:story.teamActivitySubtitle')}
        </p>
        <div className="mt-6 space-y-4">
          {busiest.map((actor, index) => (
            <div key={actor.id}>
              <div className="mb-1.5 flex items-center gap-2 text-xs">
                <span className="truncate">{actor.name}</span>
                <span className="ml-auto font-mono text-muted-foreground">{actor.events}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted/50">
                <div
                  className="story-meter h-full rounded-full"
                  style={{
                    width: `${(actor.events / maxEvents) * 100}%`,
                    background: [
                      'hsl(var(--info))',
                      'hsl(var(--primary))',
                      'hsl(var(--destructive))',
                      'hsl(var(--success))',
                      'hsl(var(--warning))',
                    ][index],
                    animationDelay: `${index * 80}ms`,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
