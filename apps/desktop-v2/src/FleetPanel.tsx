import { ArrowRight, FolderPlus, Layers3, Plus, Search, Terminal } from 'lucide-react';
import { useEffect, useState } from 'react';
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
    <section className="sessions-region" aria-label="Sessions">
      <div className="workspace-overview">
        <span>
          <i className="status-dot running" />
          <strong>{active.length}</strong> active {active.length === 1 ? 'session' : 'sessions'}
        </span>
        <span>
          <strong>{snapshot.projects.length}</strong>{' '}
          {snapshot.projects.length === 1 ? 'project' : 'projects'}
        </span>
        {attention.length > 0 && (
          <button type="button" onClick={() => setFilter('attention')}>
            {attention.length} need attention <ArrowRight size={12} />
          </button>
        )}
        <button
          type="button"
          className="overview-terminal"
          disabled={!native || !snapshot.projects.length}
          onClick={() => newSession(undefined, 'terminal')}
        >
          <Terminal size={14} />
          Open terminal
        </button>
      </div>
      <div className="section-toolbar">
        <div className="tab-list" role="tablist" aria-label="Filter sessions">
          {[
            { id: 'all', label: 'All sessions' },
            { id: 'active', label: 'Active' },
            { id: 'attention', label: 'Attention' },
            { id: 'history', label: 'History' },
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
            aria-label="Search sessions"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Find a session…"
          />
        </label>
      </div>
      {projects.map((item) => (
        <section
          className="project-session-group"
          key={item.id}
          aria-label={`${item.name} sessions`}
        >
          <header>
            <div>
              <span className={`project-symbol color-${snapshot.projects.indexOf(item) % 4}`}>
                {item.name.slice(0, 1).toUpperCase()}
              </span>
              <h2>{item.name}</h2>
              <span>
                {countLabel(
                  sessions.filter((session) => session.projectId === item.id).length,
                  'session',
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
              New session
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
              ? 'No matching sessions.'
              : snapshot.projects.length
                ? 'What are we working on?'
                : 'Bring your projects together.'}
          </h2>
          <p>
            {search || filter !== 'all'
              ? 'Try another filter or create a session for this project.'
              : 'Start a conversation or open a terminal in one of your projects.'}
          </p>
          <button
            type="button"
            className="button primary"
            disabled={!native || pending}
            onClick={() => (snapshot.projects.length ? newSession() : void run(addProject))}
          >
            {snapshot.projects.length ? <Plus size={15} /> : <FolderPlus size={15} />}
            {snapshot.projects.length ? 'Create a session' : 'Add your first project'}
            <ArrowRight size={14} />
          </button>
        </div>
      )}
    </section>
  );
}

function countLabel(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}
