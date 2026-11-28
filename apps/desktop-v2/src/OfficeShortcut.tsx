import { Building2, Folder } from 'lucide-react';
import { useDesktopText } from './desktop-i18n';
import type { DesktopController } from './useDesktop';
import { useDetailsDismiss } from './useDetailsDismiss';
import './office-shortcut.css';

export function OfficeShortcut({ vm }: { vm: DesktopController }) {
  const { t } = useDesktopText();
  const dismiss = useDetailsDismiss();
  const projects = vm.snapshot.projects;
  const project =
    vm.currentProject ??
    projects.find(({ id }) => id === vm.currentSession?.projectId) ??
    (projects.length === 1 ? projects[0] : undefined);
  const title = t('overview.links.office');
  const icon = <Building2 size={16} aria-hidden="true" />;
  if (!projects.length) return null;
  if (project) {
    return (
      <button
        type="button"
        className="icon-button office-shortcut"
        aria-label={title}
        title={title}
        aria-current={vm.section === 'project' && vm.projectPage === 'office' ? 'page' : undefined}
        onClick={() => vm.openProjectPage(project.id, 'office')}
      >
        {icon}
      </button>
    );
  }
  return (
    <details className="notification-menu office-shortcut" ref={dismiss}>
      <summary className="icon-button" aria-label={title} title={title}>
        {icon}
      </summary>
      <div className="notification-panel office-projects">
        <header>
          <strong>{title}</strong>
        </header>
        {projects.map(({ id, name }) => (
          <button
            type="button"
            className="office-project"
            key={id}
            title={name}
            onClick={() => vm.openProjectPage(id, 'office')}
          >
            <span className="office-project-mark" aria-hidden="true">
              <Folder size={13} />
            </span>
            <span className="office-project-name">{name}</span>
          </button>
        ))}
      </div>
    </details>
  );
}
