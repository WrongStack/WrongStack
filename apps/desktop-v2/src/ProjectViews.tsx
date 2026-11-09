import { Activity, ArrowRight, Folder, FolderPlus, Plus } from 'lucide-react';
import { AppearanceSettings } from './AppearanceSettings';
import { useDesktopText } from './desktop-i18n';
import { displayDateTime } from './display-dates';
import { isLive } from './model';
import { addProject, native } from './platform';
import type { DesktopController } from './useDesktop';

export function ProjectViews({ vm }: { vm: DesktopController }) {
  const { t } = useDesktopText();
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
                  {t('projects.active', {
                    count: snapshot.sessions.filter((s) => s.projectId === p.id && isLive(s))
                      .length,
                  })}
                </span>
                <span>
                  {t('projects.sessions', {
                    count: snapshot.sessions.filter((s) => s.projectId === p.id).length,
                  })}
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
                  {t('projects.open')}
                  <ArrowRight size={14} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title={t('explorer.newSession')}
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
            <strong>{t('projects.connect')}</strong>
            <span>{t('projects.select')}</span>
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
                  {snapshot.projects.find((p) => p.id === s.projectId)?.name} ·{' '}
                  {t(`kind.${s.kind}`, { defaultValue: s.kind })} ·{' '}
                  {t(`status.${s.status}`, { defaultValue: s.status })}
                  {s.exitCode !== null ? ` · ${t('activity.exit', { code: s.exitCode })}` : ''}
                </p>
              </div>
              <time>{displayDateTime(s.updatedAt)}</time>
              <ArrowRight size={16} />
            </button>
          ))}
          {!snapshot.sessions.length && (
            // The same empty state as mission control, not a bare line under a divider.
            <div className="empty-state">
              <div className="empty-illustration">
                <Activity size={32} />
              </div>
              <p>{t('activity.empty')}</p>
            </div>
          )}
        </section>
      )}
      {section === 'engine' && <AppearanceSettings vm={vm} />}
    </>
  );
}
