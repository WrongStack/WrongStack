import { ArrowRight, Folder, FolderPlus, Plus } from 'lucide-react';
import { AppearanceSettings } from './AppearanceSettings';
import { isLive } from './model';
import { addProject, native } from './platform';

import type { DesktopController } from './useDesktop';

export function ProjectViews({ vm }: { vm: DesktopController }) {
  const { snapshot, section, run, newSession, jumpToSession } = vm;
  return (
    <>
      {' '}
      {section === 'projects' && (
        <div className="projects-grid">
          {snapshot.projects.map((p, i) => (
            <article className="project-card" key={p.id}>
              <span className={`large-symbol color-${i % 4}`}>
                <Folder size={24} />
              </span>
              <h2>{p.name}</h2>
              <p className="mono">{p.root.replace(/^\\\\\?\\/, '')}</p>
              <div className="project-card-stats">
                <span>
                  {snapshot.sessions.filter((s) => s.projectId === p.id && isLive(s)).length} active
                </span>
                <span>
                  {snapshot.sessions.filter((s) => s.projectId === p.id).length}{' '}
                  {snapshot.sessions.filter((s) => s.projectId === p.id).length === 1
                    ? 'session'
                    : 'sessions'}
                </span>
              </div>
              <footer>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => {
                    vm.openProjectPage(p.id);
                  }}
                >
                  Open project
                  <ArrowRight size={14} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title="New session"
                  onClick={() => newSession(p.id)}
                >
                  <Plus size={17} />
                </button>
              </footer>
            </article>
          ))}
          <button
            type="button"
            className="project-card add-card"
            disabled={!native}
            onClick={() => void run(addProject)}
          >
            <FolderPlus size={30} />
            <strong>Connect a project</strong>
            <span>Select a local directory</span>
          </button>
        </div>
      )}
      {section === 'activity' && (
        <section className="timeline">
          {snapshot.sessions.map((s) => (
            <button type="button" key={s.id} onClick={() => jumpToSession(s)}>
              <span className={`status-dot ${s.status}`} />
              <div>
                <strong>{s.title}</strong>
                <p>
                  {snapshot.projects.find((p) => p.id === s.projectId)?.name} · {s.kind} ·{' '}
                  {s.status}
                  {s.exitCode !== null ? ` · exit ${s.exitCode}` : ''}
                </p>
              </div>
              <time>{new Date(s.updatedAt).toLocaleString()}</time>
              <ArrowRight size={16} />
            </button>
          ))}
          {!snapshot.sessions.length && (
            <p className="quiet-state">
              No session activity yet. Create a session to start your timeline.
            </p>
          )}
        </section>
      )}
      {section === 'engine' && <AppearanceSettings vm={vm} />}
    </>
  );
}
