/**
 * HQ Kanban task inspector — read-only detail panel.
 *
 * Opens when a task card is clicked. Shows full description, labels,
 * assignee, dependencies, due date, and priority. No mutation — HQ is
 * a command center, not an editor. "Open in WebUI" deep link navigates
 * to the project WebUI for editing.
 *
 * See docs/plans/hq-evolution-2026-08.md §5.1 "task-inspector.tsx".
 */
import { AlertTriangle, CheckCircle2, Clock3, ExternalLink, GitBranch, Layers, UserRound, X } from 'lucide-react';
import type React from 'react';
import { type HqKanbanBoardView, type HqKanbanTaskView } from './kanban-model.js';

export interface HqKanbanInspectorProps {
  task: HqKanbanTaskView;
  board: HqKanbanBoardView;
  /** URL to the project WebUI for the "Open in WebUI" deep link. */
  webuiUrl?: string | undefined;
  /** Dependency tasks resolved to their titles (id → title). */
  dependencyTitles?: ReadonlyMap<string, string> | undefined;
  onClose: () => void;
}

export function HqKanbanInspector({
  task,
  board,
  webuiUrl,
  dependencyTitles,
  onClose,
}: HqKanbanInspectorProps): React.ReactElement {
  const depLabels = task.dependsOn.map((depId) => {
    const title = dependencyTitles?.get(depId);
    return { id: depId, title: title ?? depId.slice(0, 8) };
  });

  return (
    <aside className="hq-kanban-inspector" role="complementary" aria-label="Task detail">
      <header className="hq-kanban-inspector-header">
        <div>
          <span className={`hq-pill ${task.status}`}>{task.status.replaceAll('_', ' ')}</span>
          <span className={`hq-kanban-priority ${task.priority}`}>{task.priority}</span>
        </div>
        <button type="button" onClick={onClose} aria-label="Close inspector" className="hq-inspector-close">
          <X size={16} />
        </button>
      </header>

      <h2 className="hq-kanban-inspector-title">{task.title}</h2>
      <span className="hq-mono hq-kanban-inspector-id">{task.id}</span>

      {task.description ? (
        <section className="hq-kanban-inspector-section">
          <h3>Description</h3>
          <p className="hq-kanban-inspector-description">{task.description}</p>
        </section>
      ) : null}

      <section className="hq-kanban-inspector-section">
        <h3>Details</h3>
        <dl className="hq-kanban-inspector-details">
          <div className="hq-kanban-inspector-row">
            <dt>
              <Layers size={13} />
              Board
            </dt>
            <dd>{board.title}</dd>
          </div>
          {task.assignee ? (
            <div className="hq-kanban-inspector-row">
              <dt>
                <UserRound size={13} />
                Assignee
              </dt>
              <dd>
                {task.assignee}
                {task.assignmentStatus ? (
                  <span className="hq-mono" style={{ marginLeft: 6, opacity: 0.7 }}>
                    ({task.assignmentStatus})
                  </span>
                ) : null}
              </dd>
            </div>
          ) : null}
          {task.dueDate ? (
            <div className="hq-kanban-inspector-row">
              <dt>
                <Clock3 size={13} />
                Due
              </dt>
              <dd>{new Date(task.dueDate).toLocaleString()}</dd>
            </div>
          ) : null}
          {task.columnId ? (
            <div className="hq-kanban-inspector-row">
              <dt>
                <Layers size={13} />
                Column
              </dt>
              <dd>
                {board.columns.find((col) => col.id === task.columnId)?.title ?? task.columnId}
              </dd>
            </div>
          ) : null}
        </dl>
      </section>

      {task.labels.length > 0 ? (
        <section className="hq-kanban-inspector-section">
          <h3>Labels</h3>
          <div className="hq-kanban-inspector-labels">
            {task.labels.map((label) => (
              <span key={label} className="hq-pill info">
                {label}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {depLabels.length > 0 ? (
        <section className="hq-kanban-inspector-section">
          <h3>
            <GitBranch size={13} />
            Dependencies ({depLabels.length})
          </h3>
          <ul className="hq-kanban-inspector-deps">
            {depLabels.map((dep) => (
              <li key={dep.id}>
                <span className="hq-mono">{dep.id.slice(0, 8)}</span>
                <span>{dep.title}</span>
                {task.status === 'completed' ? (
                  <CheckCircle2 size={13} className="is-done" />
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {task.status === 'blocked' || task.status === 'failed' ? (
        <div className="hq-kanban-inspector-alert">
          <AlertTriangle size={14} />
          <span>This task is {task.status} and may need attention.</span>
        </div>
      ) : null}

      {webuiUrl ? (
        <footer className="hq-kanban-inspector-footer">
          <a
            href={webuiUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hq-button hq-button-primary"
          >
            <ExternalLink size={14} />
            Open in WebUI
          </a>
        </footer>
      ) : null}
    </aside>
  );
}
