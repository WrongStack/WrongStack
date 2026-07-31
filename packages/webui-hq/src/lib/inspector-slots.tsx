/**
 * RightInspector shell — receives an `InspectorTarget` and dispatches to
 * the matching `InspectorSlot`. Built as a thin shell so the workbench
 * team can later swap this for `WorkbenchShell.RightInspector` without
 * changing the call sites.
 */
import type React from 'react';
import { useEffect } from 'react';
import {
  installDefaultSlots,
} from './inspector-default-slots.js';
import type { InspectorTarget } from './inspector.js';
import { resolveInspectorSlot } from './inspector.js';

export interface RightInspectorProps {
  /** `null` closes the drawer. */
  target: InspectorTarget | null;
  onClose: () => void;
}

export function RightInspector({
  target,
  onClose,
}: RightInspectorProps): React.ReactElement | null {
  // Idempotent: install defaults on first render so non-test callers
  // don't have to remember to wire them up.
  useEffect(() => {
    installDefaultSlots();
  }, []);

  if (target === null) return null;
  const resolved = resolveInspectorSlot(target);
  if (resolved === null) return null;
  return (
    <div className="hq-right-inspector-layer" data-testid={`hq-right-inspector-${target.kind}`}>
      <button
        type="button"
        className="hq-right-inspector-scrim"
        onClick={onClose}
        aria-label="Close inspector"
      />
      <aside className="hq-right-inspector-panel" aria-label="Inspector">
        <header className="hq-right-inspector-header">
          <h2 className="hq-right-inspector-title">{titleFor(target)}</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="hq-right-inspector-body">{resolved.render(target)}</div>
      </aside>
    </div>
  );
}

function titleFor(target: InspectorTarget): string {
  switch (target.kind) {
    case 'hq.kanban.task':
      return `Task · ${target.taskId.slice(0, 8)}`;
    case 'hq.mailbox.message':
      return `Message · ${target.messageId.slice(0, 8)}`;
    case 'hq.client':
      return `Client · ${target.clientId.slice(0, 16)}`;
    case 'hq.alert':
      return `Alert · ${target.alertId.slice(0, 8)}`;
    case 'hq.command':
      return `Command · ${target.commandId.slice(0, 8)}`;
    case 'hq.cost.session':
      return `Cost · ${target.sessionId.slice(0, 8)}`;
    case 'hq.worktree':
      return `Worktree · ${target.handleId.slice(0, 8)}`;
  }
}
