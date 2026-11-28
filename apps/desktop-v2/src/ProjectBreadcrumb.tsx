import { ArrowLeft, ChevronRight, Folder } from 'lucide-react';
import { useDesktopText } from './desktop-i18n';
import type { Project } from './model';
import { owningTool, projectToolGroups } from './project-tools';
import './project-tools.css';
import type { DesktopController } from './useDesktop';

/**
 * Where the page sits in the project. The title bar already names the project, so this row
 * says which of its pages is open and leads back to the overview.
 */
export function ProjectBreadcrumb({ project, vm }: { project: Project; vm: DesktopController }) {
  const { t } = useDesktopText();
  const overview = vm.projectPage === 'overview';
  const owner = owningTool(vm.projectPage);
  const group = projectToolGroups.find((entry) => entry.tools.some((tool) => tool.id === owner));
  const ToolIcon = group?.tools.find((tool) => tool.id === owner)?.Icon;
  return (
    <nav className="project-breadcrumb" aria-label={t('project.breadcrumb')}>
      <button
        type="button"
        className="project-home-button"
        title={project.root.replace(/^\\\\\?\\/, '')}
        aria-current={overview ? 'page' : undefined}
        onClick={() => vm.setProjectPage('overview')}
      >
        {!overview && <ArrowLeft size={14} />}
        <Folder size={15} />
        <strong>{project.name}</strong>
      </button>
      {!overview && (
        <>
          <ChevronRight size={13} className="project-breadcrumb-separator" aria-hidden />
          <span aria-current="page" className="project-breadcrumb-page" data-group={group?.id}>
            {ToolIcon && (
              <span className="project-breadcrumb-icon" aria-hidden="true">
                <ToolIcon size={13} />
              </span>
            )}
            {t(`pages.${vm.projectPage}`)}
          </span>
        </>
      )}
    </nav>
  );
}
