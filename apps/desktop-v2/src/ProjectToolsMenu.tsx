/**
 * ProjectToolsMenu — the one menu that lists a project's tools.
 *
 * The WebUI's tools launcher groups every tool under work, knowledge, quality
 * and system headings and marks the open one; the desktop copies that shape
 * and improves it: every tool keeps its own icon, the open tool is marked in
 * both menus, and the overview's cards carry the tool's one-line summary.
 *
 * The same component renders both menus — the sidebar's launcher and the
 * project's overview — from one catalog, so the two can never drift apart.
 */

import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useDesktopText } from './desktop-i18n';
import { owningTool, projectToolGroups } from './project-tools';
import type { ProjectPage } from './useDesktop';
import './project-tools.css';

export function ProjectToolsMenu({
  page,
  onOpen,
  variant,
  after,
  badges,
}: {
  /** The project page that is open, if any. */
  page: ProjectPage | undefined;
  /** Opens a project page. */
  onOpen: (page: ProjectPage) => void;
  variant: 'launcher' | 'overview';
  /** Rendered after the groups; the overview keeps its app-level links here. */
  after?: ReactNode;
  /** A live readout shown on a tool's card, such as the unread mailbox count. */
  badges?: Partial<Record<ProjectPage, ReactNode>>;
}) {
  const { t } = useDesktopText();
  const launcher = variant === 'launcher';
  return (
    <div className={`project-tools-menu ${variant}`}>
      {projectToolGroups.map((group) => {
        // A tool the overview promotes to a featured card is entered there.
        const tools = launcher ? group.tools : group.tools.filter((tool) => !tool.featured);
        if (!tools.length) return null;
        return (
          <section key={group.id} className="project-tools-group">
            <h3>{t(`projectTools.groups.${group.id}`)}</h3>
            <div className="project-tools-items">
              {tools.map(({ id, Icon, summaryKey }) => {
                // The live fleet is the roster's live view, so the roster stays marked.
                const open = owningTool(page) === id;
                return (
                  <button
                    type="button"
                    key={id}
                    className="project-tool"
                    aria-label={launcher ? t(`pages.${id}`) : undefined}
                    aria-current={open ? 'page' : undefined}
                    onClick={() => onOpen(id)}
                  >
                    <Icon size={launcher ? 14 : 21} />
                    <div className="project-tool-copy">
                      <strong>{t(`pages.${id}`)}</strong>
                      {!launcher && <span>{t(summaryKey)}</span>}
                      {!launcher && badges?.[id]}
                    </div>
                    {launcher ? (
                      open && <i className="project-tool-dot" aria-hidden="true" />
                    ) : (
                      <ArrowRight size={16} />
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
      {after}
    </div>
  );
}
