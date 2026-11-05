import { ArrowRight, FolderPlus, Layers3, Plus, Search, Terminal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import {
  PINNED_SESSIONS_KEY,
  readPinnedSessions,
  sortSessions,
  writePinnedSessions,
} from './model';
import { addProject, native } from './platform';
import { SessionCard } from './SessionCard';
import type { DesktopController } from './useDesktop';

export function FleetPanel({ vm }: { vm: DesktopController }) {
  const {
    snapshot,
    project,
    selected,
    filter,
    setFilter,
    search,
    setSearch,
    pending,
    run,
    newSession,
    active,
    attention,
    sessions,
    jumpToSession,
  } = vm;
  const { t } = useDesktopText();
  const [pinned, setPinned] = useState<string[]>([]);
  useEffect(() => {
    setPinned(readPinnedSessions());
    const sync = (event: StorageEvent) => {
      if (event.key === PINNED_SESSIONS_KEY || event.key === null) setPinned(readPinnedSessions());
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const togglePin = (id: string) => {
    // Windows share this storage: start from what is persisted now, not from
    // the copy this window read at mount, or one window erases another's pins.
    const current = readPinnedSessions();
    const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
    writePinnedSessions(next);
    setPinned(next);
  };
  const projects = snapshot.projects.filter(
    (item) =>
      (!project || item.id === project) &&
      sessions.some((session) => session.projectId === item.id),
  );
  return (
    <section className="sessions-region" aria-label={t('fleetView.sessionsLabel')}>
      <div className="workspace-overview">
        <span>
          <i className="status-dot running" />
          <strong>{active.length}</strong>{' '}
          {t(active.length === 1 ? 'fleetView.activeOne' : 'fleetView.activeMany')}
        </span>
        <span>
          <strong>{snapshot.projects.length}</strong>{' '}
          {t(snapshot.projects.length === 1 ? 'fleetView.projectOne' : 'fleetView.projectMany')}
        </span>
        {attention.length > 0 && (
          <button type="button" onClick={() => setFilter('attention')}>
            {t('fleetView.needAttention', { count: attention.length })} <ArrowRight size={12} />
          </button>
        )}
        <button
          type="button"
          className="overview-terminal"
          disabled={!native || !snapshot.projects.length}
          onClick={() => newSession(undefined, 'terminal')}
        >
          <Terminal size={14} />
          {t('fleetView.openTerminal')}
        </button>
      </div>
      <div className="section-toolbar">
        <div className="tab-list" role="tablist" aria-label={t('fleetView.filterSessions')}>
          {[
            { id: 'all', label: t('fleetView.tab.all') },
            { id: 'active', label: t('fleetView.tab.active') },
            { id: 'attention', label: t('fleetView.tab.attention') },
            { id: 'history', label: t('fleetView.tab.history') },
          ].map((item) => (
            <button
              type="button"
              role="tab"
              key={item.id}
              aria-selected={filter === item.id}
              className={filter === item.id ? 'current' : ''}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <label className="inline-search">
          <Search size={14} />
          <input
            aria-label={t('fleetView.searchSessions')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('fleetView.findSession')}
          />
        </label>
      </div>
      {projects.map((item) => (
        <section
          className="project-session-group"
          key={item.id}
          aria-label={t('fleetView.groupSessions', { name: item.name })}
        >
          <header>
            <div>
              <span className={`project-symbol color-${snapshot.projects.indexOf(item) % 4}`}>
                {item.name.slice(0, 1).toUpperCase()}
              </span>
              <h2>{item.name}</h2>
              <span>
                {sessionCount(
                  t,
                  sessions.filter((session) => session.projectId === item.id).length,
                )}
              </span>
            </div>
            <button
              type="button"
              className="button secondary small"
              disabled={!native || pending}
              onClick={() => newSession(item.id)}
            >
              <Plus size={13} />
              {t('fleetView.newSession')}
            </button>
          </header>
          <div className="session-grid">
            {sortSessions(
              sessions.filter((session) => session.projectId === item.id),
              pinned,
            ).map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                name={item.name}
                selected={selected === session.id}
                pinned={pinned.includes(session.id)}
                onOpen={() => jumpToSession(session)}
                onLaunch={() => jumpToSession(session)}
                onTogglePin={() => togglePin(session.id)}
              />
            ))}
          </div>
        </section>
      ))}
      {!sessions.length && (
        <div className="empty-state">
          <div className="empty-illustration">
            <Layers3 size={32} />
          </div>
          <h2>
            {search || filter !== 'all'
              ? t('fleetView.empty.noMatch')
              : snapshot.projects.length
                ? t('fleetView.empty.welcome')
                : t('fleetView.empty.noProjects')}
          </h2>
          <p>
            {search || filter !== 'all'
              ? t('fleetView.empty.tryFilter')
              : t('fleetView.empty.start')}
          </p>
          <button
            type="button"
            className="button primary"
            disabled={!native || pending}
            onClick={() => (snapshot.projects.length ? newSession() : void run(addProject))}
          >
            {snapshot.projects.length ? <Plus size={15} /> : <FolderPlus size={15} />}
            {snapshot.projects.length
              ? t('fleetView.createSession')
              : t('fleetView.addFirstProject')}
            <ArrowRight size={14} />
          </button>
        </div>
      )}
    </section>
  );
}

function sessionCount(t: (key: string, values: { count: number }) => string, count: number) {
  return t(count === 1 ? 'fleetView.sessionOne' : 'fleetView.sessionMany', { count });
}
