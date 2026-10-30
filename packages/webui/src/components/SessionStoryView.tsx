import {
  Activity,
  ArrowLeft,
  BrainCircuit,
  Clock3,
  FileCode2,
  GitFork,
  Mail,
  Pause,
  Play,
  RefreshCw,
  Terminal,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PageMotif } from '@/components/PageMotif';
import { useAppTranslation } from '@/i18n';
import { sessionModelStats } from '@/lib/session-model-stats';
import { buildSessionStory, type StoryEvent, type StoryKind } from '@/lib/session-story';
import { storyStats } from '@/lib/session-story-stats';
import { useActiveSessionId, useSessionStore } from '@/stores';
import { EMPTY_LANE, useChatLanes } from '@/stores/chat-lanes';
import { useFleetStore } from '@/stores/fleet-store';
import { useMailboxStore } from '@/stores/mailbox-store';
import { useMemoryInjectorTraceStore } from '@/stores/memory-injector-store';
import { useUIStore } from '@/stores/ui-store';
import { ContextTimeline } from './session-story/ContextTimeline';
import { ModelDashboard } from './session-story/ModelDashboard';
import { ActivityPulse, StoryChart, storyTime } from './session-story/StoryChart';
import { StoryInsights } from './session-story/StoryInsights';
import { StoryStream } from './session-story/StoryStream';
import { StoryTables } from './session-story/StoryTables';
import { TeamConstellation } from './session-story/TeamConstellation';
import { useStoryHistory } from './session-story/use-story-history';
import './session-story/story-motion.css';

export function SessionStoryView() {
  const { t } = useAppTranslation();
  const sessionId = useActiveSessionId();
  const session = useSessionStore((state) => state.session);
  const projectRoot = useSessionStore((state) => state.projectRoot);
  const running = useChatLanes((state) => state.lanes[sessionId ?? '']?.isLoading ?? false);
  const messages = useChatLanes(
    (state) => state.lanes[sessionId ?? '']?.messages ?? EMPTY_LANE.messages,
  );
  const latestRequest = [...messages].reverse().find((message) => message.role === 'user')?.content;
  const agents = useFleetStore((state) => state.agents);
  const mail = useMailboxStore((state) => state.messages);
  const traces = useMemoryInjectorTraceStore((state) => state.traces);
  const [follow, setFollow] = useState(true);
  const live =
    running ||
    [...agents.values()].some(
      (agent) => agent.sessionId === sessionId && agent.status === 'running',
    );
  const history = useStoryHistory(sessionId, follow);
  const story = useMemo(() => {
    const model = buildSessionStory(
      sessionId ?? '',
      history.events,
      [...agents.values()],
      mail,
      traces,
      projectRoot,
    );
    if (model.actors.length && session?.id === sessionId && session.startedAt > 0)
      model.start = Math.min(model.start, session.startedAt);
    return model;
  }, [sessionId, history.events, agents, mail, traces, session, projectRoot]);
  const [now, setNow] = useState(Date.now());
  const [cursor, setCursor] = useState(100);
  const [playing, setPlaying] = useState(false);
  const [kind, setKind] = useState<StoryKind | 'all'>('all');
  const [actor, setActor] = useState('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [limit, setLimit] = useState(50);
  const [tab, setTab] = useState<
    'overview' | 'timeline' | 'context' | 'models' | 'tools' | 'files' | 'team'
  >('overview');
  const [motion, setMotion] = useState(true);
  const contextTarget = useRef<HTMLElement>(null);
  const contextRequested = useUIStore((state) => state.storyContextRequested);
  const stats = useMemo(() => storyStats(story, projectRoot), [story, projectRoot]);
  const models = useMemo(() => sessionModelStats(story), [story]);
  useEffect(() => {
    setCursor(100);
    setActor('all');
    setKind('all');
    setSearch('');
    setSelectedId(null);
    setPlaying(false);
    setLimit(50);
    setFollow(true);
    setTab('overview');
  }, [sessionId]);
  useEffect(() => {
    if (!contextRequested) return;
    useUIStore.setState({ storyContextRequested: false });
    setTab('context');
    setPlaying(false);
  }, [contextRequested]);
  useEffect(() => {
    if (tab !== 'context') return;
    contextTarget.current?.scrollIntoView?.({ block: 'start' });
    contextTarget.current?.focus({ preventScroll: true });
  }, [tab, contextRequested]);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(
      () =>
        setCursor((previous) => {
          if (previous >= 100) {
            setPlaying(false);
            return 100;
          }
          return Math.min(100, previous + 1);
        }),
      200,
    );
    return () => clearInterval(timer);
  }, [playing]);
  const end = Math.max(story.end, live && follow ? now : story.end);
  const span = Math.max(0, end - story.start);
  const cursorAt = story.start + (span * cursor) / 100;
  const visible = useMemo(
    () =>
      story.events
        .filter(
          (event) =>
            event.at <= cursorAt &&
            (kind === 'all' || event.kind === kind) &&
            (actor === 'all' || event.actor === actor) &&
            `${event.title} ${event.detail}`.toLowerCase().includes(search.toLowerCase()),
        )
        .reverse(),
    [story.events, cursorAt, kind, actor, search],
  );
  const selected = story.events.find((event) => event.id === selectedId);
  const selectedActor = story.actors.find(
    (item) => item.id === (actor === 'all' ? selected?.actor : actor),
  );
  const pick = (event: StoryEvent) => {
    setSelectedId(event.id);
    setPlaying(false);
  };
  const cards = [
    {
      label: t('activity:story.cardSpan'),
      value: story.start ? storyTime(span) : '—',
      icon: Clock3,
    },
    { label: t('activity:story.cardLanes'), value: story.actors.length, icon: GitFork },
    { label: t('activity:story.cardToolCalls'), value: story.toolCalls, icon: Terminal },
    { label: t('activity:story.cardFiles'), value: story.files.length, icon: FileCode2 },
    {
      label: t('activity:story.cardMemory'),
      value: `${story.observedInjectedMemories} / ${story.memoryWrites}`,
      icon: BrainCircuit,
    },
    { label: t('activity:story.cardMail'), value: story.counts.mail, icon: Mail },
    { label: t('activity:story.cardAlerts'), value: story.counts.alert, icon: TriangleAlert },
  ];
  return (
    <div
      className="session-story h-full overflow-auto bg-background"
      data-testid="session-story"
      data-motion={motion ? 'on' : 'off'}
    >
      <div className="mx-auto max-w-[1600px] space-y-5 p-4 md:p-7">
        <header className="ws-page-header border-b border-border">
          <PageMotif kind="flow" />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => useUIStore.getState().setCurrentView('chat')}
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
              <ArrowLeft size={14} /> {t('activity:story.backToSession')}
            </button>
            <span className="rounded-full border px-3 py-1 text-xs">
              {live ? `● ${t('activity:story.sessionLive')}` : t('activity:story.recordedSession')}{' '}
              · {t('activity:story.historyEvents', { count: history.events.length })}
            </span>
          </div>
          <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0 max-w-full break-words">
              <p className="mb-2 text-xs uppercase tracking-[.25em] text-info">
                {t('activity:story.heroEyebrow')}
              </p>
              <h1 className="tracking-tight">{t('activity:story.heroHeadline')}</h1>
              {latestRequest && (
                <p className="mt-3 max-w-3xl text-sm leading-6">{latestRequest.slice(0, 320)}</p>
              )}
              <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
                {session?.id === sessionId
                  ? session.id
                  : (sessionId ?? t('activity:story.noSession'))}{' '}
                · {t('activity:story.heroSubline')}
              </p>
            </div>
            <div className="flex min-w-0 flex-wrap gap-2">
              <button
                type="button"
                aria-pressed={motion}
                onClick={() => setMotion((value) => !value)}
                className="rounded-xl border px-3 py-2 text-xs"
              >
                {t(motion ? 'activity:story.effectsOn' : 'activity:story.effectsOff')}
              </button>
              <button
                type="button"
                onClick={() => setFollow((value) => !value)}
                aria-pressed={follow}
                className="rounded-xl border px-3 py-2 text-xs"
              >
                {t(follow ? 'activity:story.followOn' : 'activity:story.followPaused')}
              </button>
              <button
                type="button"
                onClick={history.refresh}
                disabled={history.loading}
                className="flex items-center gap-2 rounded-xl border px-3 py-2 text-xs"
              >
                <RefreshCw size={14} className={history.loading ? 'animate-spin' : ''} />
                {t('activity:story.refresh')}
              </button>
            </div>
          </div>
          <div className="mt-7 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
            {cards.map((card) => (
              <div
                key={card.label}
                className="story-card rounded-2xl border border-border/70 bg-background/60 p-3"
              >
                <card.icon size={16} className="mb-3 text-muted-foreground" />
                <p className="text-2xl font-semibold tabular-nums">{card.value}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">{card.label}</p>
              </div>
            ))}
          </div>
        </header>
        <div
          role="tablist"
          aria-label={t('activity:story.tablistLabel')}
          className="sticky top-0 z-10 flex gap-1 overflow-x-auto rounded-2xl border bg-background/95 p-1.5 backdrop-blur"
        >
          {(['overview', 'timeline', 'context', 'models', 'tools', 'files', 'team'] as const).map(
            (value, index, values) => (
              <button
                key={value}
                type="button"
                role="tab"
                id={`story-tab-${value}`}
                aria-controls={`story-panel-${value}`}
                aria-selected={tab === value}
                tabIndex={tab === value ? 0 : -1}
                onClick={() => {
                  setTab(value);
                  setPlaying(false);
                }}
                onKeyDown={(event) => {
                  const next =
                    event.key === 'ArrowRight'
                      ? (index + 1) % values.length
                      : event.key === 'ArrowLeft'
                        ? (index + values.length - 1) % values.length
                        : event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? values.length - 1
                            : undefined;
                  if (next === undefined) return;
                  event.preventDefault();
                  setTab(values[next]!);
                  setPlaying(false);
                  document.getElementById(`story-tab-${values[next]}`)?.focus();
                }}
                className={`shrink-0 rounded-xl px-4 py-2 text-sm capitalize transition-colors ${tab === value ? 'bg-info/15 font-semibold text-info' : 'text-muted-foreground hover:bg-muted'}`}
              >
                {t(
                  (
                    {
                      overview: 'activity:story.tabOverview',
                      timeline: 'activity:story.tabTimeline',
                      context: 'activity:story.tabContext',
                      models: 'activity:story.tabModels',
                      tools: 'activity:story.tabTools',
                      files: 'activity:story.tabFiles',
                      team: 'activity:story.tabTeam',
                    } as const
                  )[value],
                )}
              </button>
            ),
          )}
        </div>
        <div
          role="tabpanel"
          id={`story-panel-${tab}`}
          aria-labelledby={`story-tab-${tab}`}
          className="space-y-5"
        >
          {history.error && (
            <p
              role="alert"
              className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {history.error}
            </p>
          )}
          {history.total > history.events.length && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-warning/30 bg-warning/5 p-3 text-xs">
              <span>
                {t('activity:story.partialWindow', {
                  loaded: history.events.length.toLocaleString(),
                  total: history.total.toLocaleString(),
                })}
              </span>
              {history.cursor && (
                <button
                  type="button"
                  disabled={history.loading}
                  onClick={() => {
                    setFollow(false);
                    history.loadEarlier();
                  }}
                  className="rounded border px-3 py-1"
                >
                  {t('activity:story.loadEarlier')}
                </button>
              )}
            </div>
          )}
          {tab === 'context' && (
            <section
              id="story-context-timeline"
              ref={contextTarget}
              tabIndex={-1}
              className="scroll-mt-20"
              aria-label={t('activity:story.contextTitle')}
            >
              <ContextTimeline events={history.events} />
            </section>
          )}
          {story.actors.length > 0 && tab === 'overview' && (
            <>
              <StoryInsights
                story={story}
                end={end}
                cursor={cursorAt}
                kind={kind}
                onKind={(value) => {
                  setKind(value);
                  setTab('timeline');
                  setCursor(100);
                }}
              />
              <section className="story-card flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl border bg-card px-5 py-4">
                <span className="text-sm font-semibold">{t('activity:story.recordedReach')}</span>
                {[
                  t('activity:story.reachTools', { count: stats.tools.length }),
                  t('activity:story.reachPaths', { count: stats.files.length }),
                  t('activity:story.reachDirs', { count: stats.directories }),
                  t('activity:story.reachReads', {
                    count: stats.files.reduce((sum, file) => sum + file.reads, 0),
                  }),
                  t('activity:story.reachEdits', {
                    count: stats.files.reduce((sum, file) => sum + file.edits + file.writes, 0),
                  }),
                ].map((value) => (
                  <span key={value} className="font-mono text-xs text-muted-foreground">
                    {value}
                  </span>
                ))}
                <button
                  type="button"
                  onClick={() => setTab('files')}
                  className="ml-auto text-xs text-info underline"
                >
                  {t('activity:story.inspectFiles')}
                </button>
              </section>
              <ActivityPulse story={story} end={end} />
            </>
          )}
          {(tab === 'tools' || tab === 'files') && (
            <StoryTables
              key={tab}
              stats={stats}
              type={tab}
              onInspect={(value) => {
                setSearch(value);
                setKind('all');
                setActor('all');
                setCursor(100);
                setTab('timeline');
                setLimit(50);
              }}
            />
          )}
          {tab === 'models' && (
            <ModelDashboard
              models={models}
              onInspect={(event) => {
                setSearch('');
                setKind('all');
                setActor('all');
                setCursor(100);
                setTab('timeline');
                pick(event);
              }}
            />
          )}
          {tab === 'timeline' && story.actors.length > 0 && (
            <>
              <ActivityPulse story={story} end={end} />
              <section className="flex flex-wrap items-center gap-3 rounded-2xl border bg-card p-4">
                <button
                  type="button"
                  aria-label={t(
                    playing ? 'activity:story.pauseReplay' : 'activity:story.playReplay',
                  )}
                  onClick={() => {
                    setFollow(false);
                    if (!playing && cursor >= 100) setCursor(0);
                    setPlaying((value) => !value);
                  }}
                  className="rounded-full border p-2"
                >
                  {playing ? <Pause size={16} /> : <Play size={16} />}
                </button>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={cursor}
                  aria-label={t('activity:story.replayPosition')}
                  onChange={(event) => {
                    setCursor(Number(event.target.value));
                    setPlaying(false);
                    setFollow(false);
                  }}
                  className="min-w-40 flex-1 accent-info"
                />
                <span className="font-mono text-xs tabular-nums">
                  +{storyTime(cursorAt - story.start)} / {storyTime(span)}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setCursor(100);
                    setPlaying(false);
                  }}
                  className="text-xs underline"
                >
                  {t('activity:story.latest')}
                </button>
              </section>
              <StoryChart
                story={story}
                end={end}
                cursor={cursorAt}
                selected={selectedId}
                onSelect={pick}
                actor={actor}
              />
            </>
          )}
          {story.actors.length === 0 && (
            <div className="rounded-2xl border border-dashed p-10 text-center text-muted-foreground">
              <Activity className="mx-auto mb-3" />
              <p>
                {history.loading ? t('activity:story.loading') : t('activity:story.emptyTitle')}
              </p>
              <p className="mt-2 text-xs">{t('activity:story.emptyHint')}</p>
            </div>
          )}
          {(tab === 'timeline' || tab === 'team') && (
            <div
              className={
                tab === 'timeline'
                  ? 'grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(280px,0.6fr)]'
                  : ''
              }
            >
              {tab === 'timeline' && (
                <StoryStream
                  story={story}
                  events={visible}
                  actor={actor}
                  kind={kind}
                  search={search}
                  limit={limit}
                  selectedId={selectedId}
                  onSearch={(value) => {
                    setSearch(value);
                    setLimit(50);
                  }}
                  onActor={(value) => {
                    setActor(value);
                    setLimit(50);
                  }}
                  onKind={(value) => {
                    setKind(value);
                    setLimit(50);
                  }}
                  onSelect={pick}
                  onMore={() => setLimit((value) => value + 50)}
                />
              )}
              <aside
                className={tab === 'team' ? 'grid items-start gap-5 md:grid-cols-2' : 'space-y-5'}
              >
                {story.actors.length > 0 && (
                  <TeamConstellation actors={story.actors} selected={actor} onSelect={setActor} />
                )}
                {selectedActor && (
                  <section className="rounded-2xl border bg-card p-4">
                    <h2 className="font-semibold">{selectedActor.name}</h2>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {[selectedActor.model, selectedActor.status].filter(Boolean).join(' · ')}
                    </p>
                    <p className="mt-3 whitespace-pre-wrap break-words text-sm">
                      {selectedActor.task || t('activity:story.noAssignment')}
                    </p>
                  </section>
                )}
                <section className="rounded-2xl border bg-card p-4">
                  <h2 className="font-semibold">{t('activity:story.eventEvidence')}</h2>
                  {selected ? (
                    <div className="mt-4 space-y-3">
                      <p className="break-words text-sm font-medium">{selected.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(selected.at).toLocaleString()} · {selected.kind}
                      </p>
                      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted/40 p-3 text-xs">
                        {selected.detail}
                      </pre>
                      {selected.raw && (
                        <details>
                          <summary className="cursor-pointer text-xs text-muted-foreground">
                            {t('activity:story.recordedMetadata')}
                          </summary>
                          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-[11px]">
                            {JSON.stringify(selected.raw, null, 2)}
                          </pre>
                        </details>
                      )}
                    </div>
                  ) : (
                    <p className="mt-4 text-sm text-muted-foreground">
                      {t('activity:story.evidenceHint')}
                    </p>
                  )}
                </section>
                <section className="rounded-2xl border bg-card p-4">
                  <h2 className="font-semibold">{t('activity:story.fileFootprint')}</h2>
                  <ul className="mt-3 space-y-2">
                    {story.files.slice(0, 30).map((path) => (
                      <li
                        key={path}
                        className="break-all font-mono text-[11px] text-muted-foreground"
                      >
                        {path}
                      </li>
                    ))}
                  </ul>
                  {story.files.length === 0 && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      {t('activity:story.noFiles')}
                    </p>
                  )}
                  {story.files.length > 30 && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t('activity:story.morePaths', { count: story.files.length - 30 })}
                    </p>
                  )}
                </section>
                <p className="px-2 text-[11px] leading-5 text-muted-foreground">
                  {t('activity:story.scopeNote')}
                </p>
              </aside>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
