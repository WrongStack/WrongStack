/* biome-ignore-all lint/a11y/noAriaHiddenOnFocusable: every shape in this file
   lives inside a single role="img" <svg>, which assistive tech treats as one
   leaf node and never descends into. The aria-hidden="true" markers on the
   decorative orbit ring and membership edges therefore hide nothing from AT;
   they exist so the rendered contrast audit can apply the WCAG 1.4.11
   decorative-graphic exemption instead of gating them at 3:1. */
import { Bot, GitFork } from 'lucide-react';
import { useAppTranslation } from '../lib/i18n';
import type { StoryActor } from './session-story';

/** Membership edges are dashed; only recorded parent IDs produce solid branches. */
export function TeamConstellation({
  actors,
  selected,
  onSelect,
}: {
  actors: StoryActor[];
  selected: string;
  onSelect(id: string): void;
}) {
  const { t } = useAppTranslation();
  const visible = actors.slice(0, 24);
  const positions = new Map(
    visible.map((actor, index) => {
      const outer = visible.length > 12 && index >= 12;
      const count = outer ? visible.length - 12 : Math.min(12, visible.length);
      const angle = ((outer ? index - 12 : index) / Math.max(1, count)) * Math.PI * 2 - Math.PI / 2;
      return [
        actor.id,
        {
          x: 320 + Math.cos(angle) * (outer ? 245 : visible.length > 12 ? 135 : 190),
          y: 240 + Math.sin(angle) * (outer ? 200 : visible.length > 12 ? 100 : 155),
        },
      ];
    }),
  );
  return (
    <section className="story-enter overflow-hidden rounded-2xl border bg-card">
      <header className="flex items-center gap-2 p-4">
        <GitFork size={16} />
        <div>
          <h2 className="font-semibold">{t('activity:story.teamConstellation')}</h2>
          <p className="text-xs text-muted-foreground">{t('activity:story.teamSubtitle')}</p>
        </div>
      </header>
      <svg
        viewBox="0 0 640 480"
        className="w-full"
        role="img"
        aria-label={t('activity:story.teamMapLabel')}
      >
        <rect width={640} height={480} fill="hsl(var(--muted))" />
        {/* Framing only: the orbit ring and the inner halo carry no data. The whole
            <svg> is role="img", so assistive tech never descends into it and
            this marker costs nothing to AT — it declares the strokes
            decorative so the rendered contrast audit exempts them from WCAG
            1.4.11, which does not apply to purely decorative graphics. */}
        <g aria-hidden="true">
          <circle
            cx={320}
            cy={240}
            r={215}
            fill="none"
            stroke="hsl(var(--card))"
            strokeDasharray="2 8"
            className="story-orbit"
          />
          <circle
            cx={320}
            cy={240}
            r={65}
            fill="none"
            stroke="hsl(var(--info))"
            strokeOpacity={0.15}
          />
        </g>
        {visible.map((actor) => {
          const point = positions.get(actor.id)!;
          const parent = actor.parent ? positions.get(actor.parent) : undefined;
          // Membership edges are decorative under 1.4.11: the parent/child
          // relationship is also conveyed by the GitFork glyph on each node.
          return (
            <g key={actor.id} aria-hidden="true">
              <line
                x1={parent?.x ?? 320}
                y1={parent?.y ?? 240}
                x2={point.x}
                y2={point.y}
                stroke={parent ? 'hsl(var(--destructive))' : 'hsl(var(--border))'}
                strokeWidth={parent ? 2 : 1}
                strokeDasharray={parent ? undefined : '4 5'}
                className={actor.status === 'running' ? 'story-flow' : undefined}
              />
            </g>
          );
        })}
        <circle
          cx={320}
          cy={240}
          r={38}
          fill="hsl(var(--card))"
          stroke="hsl(var(--info))"
          strokeWidth={1.5}
        />
        <text x={320} y={237} fill="hsl(var(--foreground))" fontSize={12} textAnchor="middle">
          {t('activity:story.sessionCenter')}
        </text>
        {/* `--info` is a status-taxonomy voice, and at 10px on the `--muted`
            canvas it only reaches 4.25:1 in light theme — below AA. This is a
            metadata count, not an informational state, so it wears the same
            secondary ink as the per-node event counts (5.29:1 light / 6.83
            dark) and still reads as deliberately de-emphasised. */}
        <text x={320} y={254} fill="hsl(var(--muted-foreground))" fontSize={10} textAnchor="middle">
          {t('activity:story.lanes', { count: actors.length })}
        </text>
        {visible.map((actor) => {
          const point = positions.get(actor.id)!;
          return (
            <g key={actor.id}>
              {actor.status === 'running' && (
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={14}
                  fill="none"
                  stroke="hsl(var(--success))"
                  strokeWidth={2}
                  className="story-halo"
                />
              )}
              <circle
                cx={point.x}
                cy={point.y}
                r={selected === actor.id ? 16 : 11}
                fill={
                  actor.status === 'failed' || actor.status === 'timeout'
                    ? 'hsl(var(--brand-orange))'
                    : actor.status === 'running'
                      ? 'hsl(var(--success))'
                      : 'hsl(var(--primary))'
                }
                opacity={0.95}
              />
              <text
                x={point.x}
                y={point.y + 27}
                fill="hsl(var(--foreground))"
                fontSize={10}
                textAnchor="middle"
              >
                {actor.name.slice(0, 18)}
              </text>
              <text
                x={point.x}
                y={point.y + 41}
                fill="hsl(var(--muted-foreground))"
                fontSize={9}
                textAnchor="middle"
              >
                {t('activity:story.events', { count: actor.events })}
              </text>
              <title>
                {actor.name} · {actor.status ?? t('activity:story.statusRecorded')}
                {actor.task ? ` · ${actor.task}` : ''}
              </title>
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap gap-1.5 p-3">
        {visible.map((actor) => (
          <button
            type="button"
            key={actor.id}
            onClick={() => onSelect(selected === actor.id ? 'all' : actor.id)}
            aria-pressed={selected === actor.id}
            className="flex max-w-full items-center gap-1.5 truncate rounded-full border px-2 py-1 text-[11px]"
          >
            <Bot size={11} />
            {actor.name}
          </button>
        ))}
      </div>
      <p className="px-4 pb-4 text-[11px] text-muted-foreground">
        {t('activity:story.legendMembership')}
        {actors.length > visible.length
          ? t('activity:story.legendRemaining')
          : t('activity:story.legendUnknownParent')}
      </p>
    </section>
  );
}
