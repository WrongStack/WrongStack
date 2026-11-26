import { Terminal, Workflow, X } from 'lucide-react';
import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { type Session, sessionTitle } from './model';

/**
 * One tab of the session strip. Its name is the session's: the first prompt of an agent
 * conversation names it, and the user can rename it in place (double-click, or F2). However
 * long the name, the tab keeps a bounded width; the name ends in an ellipsis and the tooltip
 * shows it whole.
 *
 * The strip is a roving-tabindex tablist: only one tab is a Tab stop, arrows/Home/End move
 * that focus between tabs, Enter or Space opens the focused session, and Delete detaches
 * it — so the close control stays reachable without widening the Tab order. The workbench
 * wires each tab to the shared session panel through `tabId`/`panelId`.
 */
export function SessionTab({
  session,
  active,
  projectName,
  focusable = true,
  tabId,
  panelId,
  onOpen,
  onClose,
  onRename,
}: {
  session: Session;
  active: boolean;
  /** Named only for a session from another project than the active one. */
  projectName?: string | undefined;
  /** False while the strip's roving keyboard focus sits on another tab. */
  focusable?: boolean | undefined;
  /** Strip wiring: identifies this tab and the shared session panel it controls. */
  tabId?: string | undefined;
  panelId?: string | undefined;
  onOpen: () => void;
  onClose: () => void;
  onRename: (title: string) => void;
}) {
  const { t } = useDesktopText();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const title = sessionTitle(session, t('workbench.untitled'));
  const full = projectName ? `${projectName} / ${title}` : title;
  const startRename = () => {
    setDraft(session.untitled ? '' : session.title);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && (session.untitled || next !== session.title)) onRename(next);
  };
  return (
    <div
      className={`session-tab ${active ? 'active-session-tab' : ''}`}
      data-session-id={session.id}
    >
      {editing ? (
        <span className="session-tab-label session-tab-editing">
          {session.kind === 'terminal' ? <Terminal size={13} /> : <Workflow size={13} />}
          <input
            className="session-tab-rename"
            aria-label={t('workbench.rename')}
            value={draft}
            placeholder={title}
            maxLength={200}
            // biome-ignore lint/a11y/noAutofocus: the field opens on an explicit rename request.
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setEditing(false);
              }
            }}
          />
        </span>
      ) : (
        <button
          type="button"
          className="session-tab-label"
          id={tabId}
          role="tab"
          aria-selected={active}
          aria-controls={panelId}
          tabIndex={focusable ? 0 : -1}
          title={t('workbench.tabHint', { title: full })}
          onClick={onOpen}
          onDoubleClick={startRename}
          onKeyDown={(event) => {
            if (event.key === 'F2') {
              event.preventDefault();
              startRename();
            }
          }}
        >
          {session.kind === 'terminal' ? <Terminal size={13} /> : <Workflow size={13} />}
          <span>
            {projectName && <small>{projectName}</small>}
            <span className={`session-tab-title ${session.untitled ? 'untitled' : ''}`.trim()}>
              {title}
            </span>
          </span>
        </button>
      )}
      {/* Delete on a focused tab detaches it; this button leaves the Tab order. */}
      <button
        type="button"
        className="session-tab-close"
        tabIndex={-1}
        title={t('workbench.detach', { title })}
        aria-label={t('workbench.detach', { title })}
        onClick={onClose}
      >
        <X size={12} />
      </button>
    </div>
  );
}
