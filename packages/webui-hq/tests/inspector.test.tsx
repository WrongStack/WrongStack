/**
 * Tests for the RightInspector contract:
 *   - Registry resolves only known kinds.
 *   - The shell renders only when a target is provided.
 *   - Unknown kinds close gracefully (returns `null`) instead of throwing.
 *   - Default slots for `hq.kanban.task`, `hq.mailbox.message`, `hq.client`
 *     are registered by `installDefaultSlots()` and produce non-empty
 *     bodies that read live store state.
 *
 * @vitest-environment jsdom
 */

import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearInspectorSlots,
  registerInspectorSlot,
  resolveInspectorSlot,
} from '../src/lib/inspector.js';
import { installDefaultSlots } from '../src/lib/inspector-default-slots.js';
import { RightInspector } from '../src/lib/inspector-slots.js';
import { useHqStore } from '../src/store.js';

afterEach(() => {
  clearInspectorSlots();
  // Reset the store between tests so cursors/snapshot state doesn't leak.
  useHqStore.setState({
    snapshot: null,
    events: [],
    alerts: [],
    commandStatuses: [],
    activeView: 'cockpit',
    selectedSessionId: null,
    selectedAgentId: null,
    selectedClientId: null,
    connected: false,
    authRequired: false,
    resumeCursors: {},
    needsSnapshotRefresh: false,
    peerRehydrate: null,
  });
});

describe('RightInspector registry', () => {
  it('returns null for unknown target kinds', () => {
    expect(resolveInspectorSlot({ kind: 'hq.worktree', handleId: 'h1' })).toBeNull();
  });

  it('installs and resolves default slots for the three documented kinds', () => {
    installDefaultSlots();
    for (const kind of ['hq.kanban.task', 'hq.mailbox.message', 'hq.client'] as const) {
      expect(resolveInspectorSlot({ kind, ...defaultTargetFor(kind) } as never)).not.toBeNull();
    }
  });

  it('lets a caller override a default slot with their own renderer', () => {
    installDefaultSlots();
    const dispose = registerInspectorSlot({
      kind: 'hq.client',
      render: () => null,
    });
    const resolved = resolveInspectorSlot({
      kind: 'hq.client',
      projectId: 'p1',
      clientId: 'c1',
    });
    expect(resolved?.render({ kind: 'hq.client', projectId: 'p1', clientId: 'c1' })).toBeNull();
    dispose();
    installDefaultSlots();
    expect(
      resolveInspectorSlot({
        kind: 'hq.client',
        projectId: 'p1',
        clientId: 'c1',
      }),
    ).not.toBeNull();
  });

  it('keeps a stale registration from clobbering a newer one', () => {
    const oldSlot = { kind: 'hq.client' as const, render: () => null };
    const disposeOld = registerInspectorSlot(oldSlot);
    disposeOld();
    installDefaultSlots();
    expect(resolveInspectorSlot({ kind: 'hq.client', projectId: 'p', clientId: 'c' })).not.toBe(
      oldSlot,
    );
  });
});

describe('RightInspector shell', () => {
  it('renders null when target is null (drawer closed)', () => {
    installDefaultSlots();
    const html = renderToString(<RightInspector target={null} onClose={() => undefined} />);
    expect(html).toBe('');
  });

  it('renders the kanban-task inspector when given a task target', () => {
    installDefaultSlots();
    const html = renderToString(
      <RightInspector
        target={{ kind: 'hq.kanban.task', projectId: 'p1', taskId: 'task-42' }}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain('hq-right-inspector-hq.kanban.task');
    expect(html).toContain('Task · task-42');
    expect(html).toContain('Open in WebUI');
    // C2 — first-class navigator button on every task card.
    expect(html).toContain('hq-open-in-webui');
    expect(html).toContain('data-testid="hq-open-in-webui-kanban-task"');
    expect(html).toContain('href="/projects/p1/board?task=task-42"');
  });

  it('renders the mailbox-message inspector with the documented deep link', () => {
    installDefaultSlots();
    const html = renderToString(
      <RightInspector
        target={{
          kind: 'hq.mailbox.message',
          projectId: 'p1',
          mailboxId: 'mb-1',
          messageId: 'msg-9',
        }}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain('Message · msg-9');
    expect(html).toContain('mb-1');
    expect(html).toContain('Open in WebUI');
  });

  it('renders the client inspector reading live store state', () => {
    installDefaultSlots();
    useHqStore.setState({
      snapshot: {
        generatedAt: '2026-07-31T12:00:00.000Z',
        clients: [
          {
            clientId: 'c-42',
            kind: 'tui',
            machineId: 'm-42',
            connected: true,
            connectedAt: '2026-07-31T12:00:00.000Z',
            lastSeenAt: '2026-07-31T12:00:00.000Z',
            projectId: 'p1',
            capabilities: ['control.receive'],
          },
        ],
        projects: [],
        sessions: [],
        fleets: [],
        mailboxes: [],
        totals: {
          activeProjects: 1,
          activeClients: 1,
          activeSessions: 0,
          activeSubagents: 0,
          unreadMailboxMessages: 0,
          incompleteMailboxMessages: 0,
          totalCostUsd: 0,
        },
      },
    });
    const html = renderToString(
      <RightInspector
        target={{ kind: 'hq.client', projectId: 'p1', clientId: 'c-42' }}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain('Client · c-42');
    expect(html).toContain('c-42');
  });

  it('returns null instead of throwing on an unknown kind', () => {
    installDefaultSlots();
    const html = renderToString(
      <RightInspector
        // Cast through `unknown` so the compiler accepts an unregistered
        // kind for this negative-path test.
        target={
          { kind: 'hq.worktree', handleId: 'h' } as unknown as Parameters<
            typeof RightInspector
          >[0]['target']
        }
        onClose={() => undefined}
      />,
    );
    expect(html).toBe('');
  });
});

function defaultTargetFor(kind: 'hq.kanban.task' | 'hq.mailbox.message' | 'hq.client') {
  switch (kind) {
    case 'hq.kanban.task':
      return { projectId: 'p1', taskId: 'task-1' };
    case 'hq.mailbox.message':
      return { projectId: 'p1', mailboxId: 'mb-1', messageId: 'msg-1' };
    case 'hq.client':
      return { projectId: 'p1', clientId: 'c-1' };
  }
}
