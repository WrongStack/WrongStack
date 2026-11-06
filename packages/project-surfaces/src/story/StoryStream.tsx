import {
  Activity,
  Bot,
  BrainCircuit,
  FileCode2,
  GitFork,
  Mail,
  Search,
  Sparkles,
  Terminal,
  TriangleAlert,
} from 'lucide-react';
import { displayDecimal, useAppTranslation } from '../lib/i18n';
import { storyTime } from './StoryChart';
import {
  type buildSessionStory,
  STORY_COLORS,
  type StoryEvent,
  type StoryKind,
} from './session-story';

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

const icons = {
  model: BrainCircuit,
  tool: Terminal,
  file: FileCode2,
  memory: Sparkles,
  agent: Bot,
  mail: Mail,
  alert: TriangleAlert,
  session: Activity,
  work: GitFork,
};
interface Props {
  story: ReturnType<typeof buildSessionStory>;
  events: StoryEvent[];
  actor: string;
  kind: StoryKind | 'all';
  search: string;
  limit: number;
  selectedId: string | null;
  onSearch(value: string): void;
  onActor(value: string): void;
  onKind(value: StoryKind | 'all'): void;
  onSelect(event: StoryEvent): void;
  onMore(): void;
}
export function StoryStream({
  story,
  events,
  actor,
  kind,
  search,
  limit,
  selectedId,
  onSearch,
  onActor,
  onKind,
  onSelect,
  onMore,
}: Props) {
  const { t } = useAppTranslation();
  return (
    <section className="min-w-0 rounded-2xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{t('activity:story.eventStream')}</h2>
        <span className="text-xs text-muted-foreground">
          {t('activity:story.matchingEvents', { count: events.length })}
        </span>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <label className="flex min-w-40 flex-1 items-center gap-2 rounded-lg border px-3">
          <Search size={14} />
          <input
            aria-label={t('activity:story.searchEventsLabel')}
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder={t('activity:story.searchPlaceholder')}
            className="w-full bg-transparent py-2 text-xs outline-none"
          />
        </label>
        <select
          aria-label={t('activity:story.agentLabel')}
          value={actor}
          onChange={(event) => onActor(event.target.value)}
          className="max-w-60 rounded-lg border bg-background px-2 text-xs"
        >
          <option value="all">{t('activity:story.allTeamMembers')}</option>
          {story.actors.map((lane) => (
            <option key={lane.id} value={lane.id}>
              {lane.name}
            </option>
          ))}
        </select>
      </div>
      <div className="my-4 flex flex-wrap gap-1.5">
        <button
          type="button"
          aria-pressed={kind === 'all'}
          onClick={() => onKind('all')}
          className="rounded-full border px-2.5 py-1 text-xs"
        >
          {t('activity:story.filterAll')}
        </button>
        {Object.keys(STORY_COLORS).map((key) => (
          <button
            type="button"
            key={key}
            aria-pressed={kind === key}
            onClick={() => onKind(key as StoryKind)}
            className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
          >
            <span
              className="size-1.5 rounded-full"
              style={{ background: STORY_COLORS[key as StoryKind] }}
            />
            {t(KIND_KEYS[key as StoryKind])} {story.counts[key as StoryKind]}
          </button>
        ))}
      </div>
      <ol className="space-y-1">
        {events.slice(0, limit).map((event) => {
          const Icon = icons[event.kind];
          return (
            <li key={event.id}>
              <button
                type="button"
                onClick={() => onSelect(event)}
                className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors hover:bg-muted/50 ${selectedId === event.id ? 'border-info/50 bg-info/5' : 'border-transparent'}`}
              >
                <span
                  className="mt-1 rounded-lg p-2"
                  style={{
                    color: STORY_COLORS[event.kind],
                    background: `${STORY_COLORS[event.kind]}15`,
                  }}
                >
                  <Icon size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{event.title}</span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {story.actors.find((lane) => lane.id === event.actor)?.name ?? event.actor} ·{' '}
                    {event.detail.split('\n')[0]}
                  </span>
                </span>
                <span className="shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                  +{storyTime(event.at - story.start)}
                  {event.durationMs !== undefined && (
                    <span className="mt-1 block">{displayDecimal(event.durationMs, 0)}ms</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {events.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {t('activity:story.noMatchingEvents')}
        </p>
      )}
      {events.length > limit && (
        <button
          type="button"
          onClick={onMore}
          className="mt-3 w-full rounded-xl border p-2 text-xs"
        >
          {t('activity:story.showMore')}
        </button>
      )}
    </section>
  );
}
