/**
 * Default InspectorSlot implementations for the three documented kinds.
 *
 * Sourced from `webui-operator-workbench-2026-07.md` §3 + the HQ plan
 * §3.2 #1. Each slot renders a minimal read-only view of the record
 * and an "Open in WebUI" deep link; mutations stay in the per-project
 * WebUI session.
 */
import type React from 'react';
import { useHqStore } from '../store.js';
import type {
  InspectorSlot,
  InspectorTarget,
} from './inspector.js';
import { registerInspectorSlot } from './inspector.js';

const installed = new Set<string>();

/** Idempotent — safe to call from multiple places. */
export function installDefaultSlots(): void {
  for (const kind of ['hq.kanban.task', 'hq.mailbox.message', 'hq.client'] as const) {
    if (installed.has(kind)) continue;
    installed.add(kind);
  }
  registerInspectorSlot({
    kind: 'hq.kanban.task',
    render: (target) =>
      target.kind === 'hq.kanban.task' ? <KanbanTaskInspector target={target} /> : null,
  });
  registerInspectorSlot({
    kind: 'hq.mailbox.message',
    render: (target) =>
      target.kind === 'hq.mailbox.message' ? (
        <MailboxMessageInspector target={target} />
      ) : null,
  });
  registerInspectorSlot({
    kind: 'hq.client',
    render: (target) =>
      target.kind === 'hq.client' ? <ClientInspector target={target} /> : null,
  });
}

// ── Concrete slots ────────────────────────────────────────────────────────

function KanbanTaskInspector({
  target,
}: {
  target: Extract<InspectorTarget, { kind: 'hq.kanban.task' }>;
}): React.ReactElement {
  return (
    <div className="hq-kanban-task-inspector" data-task-id={target.taskId}>
      <h3>Task · {target.taskId}</h3>
      <p>Project: {target.projectId}</p>
      <p>(HQ is read-only. Mutations happen in the per-project WebUI.)</p>
      <a
        className="hq-open-in-webui"
        data-testid="hq-open-in-webui-kanban-task"
        href={`/projects/${encodeURIComponent(target.projectId)}/board?task=${encodeURIComponent(target.taskId)}`}
      >
        Open in WebUI
      </a>
    </div>
  );
}

function MailboxMessageInspector({
  target,
}: {
  target: Extract<InspectorTarget, { kind: 'hq.mailbox.message' }>;
}): React.ReactElement {
  return (
    <div className="hq-mailbox-message-inspector" data-message-id={target.messageId}>
      <h3>Message · {target.messageId}</h3>
      <p>
        Mailbox <code>{target.mailboxId}</code> · Project{' '}
        <code>{target.projectId}</code>
      </p>
      <p>(Read-only in HQ. Use the project WebUI to reply.)</p>
      <a
        className="hq-open-in-webui"
        data-testid="hq-open-in-webui-mailbox-message"
        href={`/projects/${encodeURIComponent(target.projectId)}/mailbox/${encodeURIComponent(target.mailboxId)}?message=${encodeURIComponent(target.messageId)}`}
      >
        Open in WebUI
      </a>
    </div>
  );
}

function ClientInspector({
  target,
}: {
  target: Extract<InspectorTarget, { kind: 'hq.client' }>;
}): React.ReactElement {
  const client = useHqStore((s) =>
    s.snapshot?.clients?.find((c) => c.clientId === target.clientId) ?? null,
  );
  return (
    <div className="hq-client-inspector" data-client-id={target.clientId}>
      <h3>Client · {target.clientId}</h3>
      <p>Project: {target.projectId}</p>
      <pre data-testid="hq-client-inspector-body">
        {client
          ? JSON.stringify(
              {
                clientId: client.clientId,
                kind: client.kind,
                machineId: client.machineId,
                connected: client.connected,
                lastSeenAt: client.lastSeenAt,
                capabilities: client.capabilities,
              },
              null,
              2,
            )
          : '(not connected or unknown)'}
      </pre>
    </div>
  );
}

// Keep the `InspectorSlot` type exported so future slot files can
// re-export their slot lists without re-importing from `./inspector.js`.
export type { InspectorSlot };
