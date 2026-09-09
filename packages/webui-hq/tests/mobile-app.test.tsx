/** @vitest-environment jsdom */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type { HqClientRecord, HqSessionSnapshotPayload, HqSnapshot } from '@wrongstack/core/hq';
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const postCommand = vi.fn(() => Promise.resolve({ commandId: 'cmd-1', queued: true }));
const postMailboxSend = vi.fn(() =>
  Promise.resolve({ delivered: true, messageId: 'mail-1', to: 'leader', type: 'steer' }),
);
const authorizedFetch = vi.fn(() => Promise.resolve(new Response('{}')));
const fetchJson = vi.fn(() => Promise.resolve({ events: [] }));

vi.mock('../src/data/api.js', () => ({
  authorizedFetch,
  fetchJson,
  postCommand,
  postMailboxSend,
}));

vi.mock('../src/domain/use-session-transcript.js', () => ({
  turnKey: (_entry: unknown, index: number) => String(index),
  useSessionTranscript: () => ({
    entries: [],
    loading: false,
    error: null,
    meta: { total: 0 },
    full: false,
    setFull: vi.fn(),
    stats: { turns: 0, tools: 0, errors: 0, running: 0 },
    isRunningAt: () => false,
    listRef: createRef(),
    onScroll: vi.fn(),
    pinned: true,
    jumpToLatest: vi.fn(),
  }),
}));

const { MobileApp } = await import('../src/mobile/mobile-app.js');
const { useHqStore } = await import('../src/data/store/index.js');

const NOW = '2026-09-09T12:00:00.000Z';

function liveSession(): HqSessionSnapshotPayload {
  return {
    sessionId: 'session-mobile',
    clientId: 'control-client',
    clientKind: 'tui',
    machineId: 'phone-target-machine',
    hostname: 'VPS-01',
    pid: 42,
    projectId: 'project-mobile',
    projectName: 'Mobile Project',
    projectRoot: '/srv/mobile-project',
    status: 'active',
    startedAt: NOW,
    lastActivityAt: NOW,
    agentCount: 2,
    agents: [
      {
        id: 'leader',
        name: 'leader',
        status: 'running',
        iterations: 1,
        toolCalls: 2,
        lastActivityAt: NOW,
      },
      {
        id: 'worker-1',
        name: 'worker',
        status: 'idle',
        iterations: 1,
        toolCalls: 1,
        lastActivityAt: NOW,
      },
    ],
  };
}

function client(clientId: string, capabilities: HqClientRecord['capabilities']): HqClientRecord {
  return {
    clientId,
    kind: 'tui',
    machineId: 'phone-target-machine',
    hostname: 'VPS-01',
    pid: 42,
    connected: true,
    connectedAt: NOW,
    lastSeenAt: NOW,
    projectId: 'project-mobile',
    capabilities,
  };
}

function mobileSnapshot(clients: HqClientRecord[]): HqSnapshot {
  return {
    generatedAt: NOW,
    clients,
    projects: [],
    sessions: [],
    fleets: [],
    mailboxes: [],
    liveSessions: [liveSession()],
    totals: {
      activeProjects: 1,
      activeClients: clients.length,
      activeSessions: 1,
      activeSubagents: 1,
      unreadMailboxMessages: 0,
      incompleteMailboxMessages: 0,
      totalCostUsd: 0,
    },
  };
}

let root: Root;
let host: HTMLDivElement;

async function mount(clients: HqClientRecord[]): Promise<void> {
  useHqStore.setState({
    snapshot: mobileSnapshot(clients),
    connected: true,
    authRequired: false,
    selectedSessionId: 'session-mobile',
    selectedAgentId: null,
    selectedClientId: null,
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<MobileApp />));
}

async function enterMessage(value: string): Promise<void> {
  const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="Message Leader"]');
  if (textarea === null) throw new Error('mobile composer not found');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  authorizedFetch.mockClear();
  fetchJson.mockClear();
  postCommand.mockClear();
  postMailboxSend.mockClear();
});

function paneButton(label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="mobile-pane"]')].find(
    (candidate) => candidate.textContent?.includes(label),
  );
  if (button === undefined) throw new Error(`mobile pane not found: ${label}`);
  return button;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

describe('HQ mobile app', () => {
  it('renders the phone shell with session and agent selectors', async () => {
    await mount([
      client('control-client', ['telemetry.publish', 'session.summary', 'control.receive']),
    ]);

    expect(host.querySelector('[data-testid="hq-mobile"]')).not.toBeNull();
    expect(host.textContent).toContain('Mobile Project · VPS-01 · TUI');
    expect(host.textContent).toContain('worker · idle');
    expect(host.textContent).toContain('control');
    expect(paneButton('Kanban')).toBeDefined();
  });

  it('sends live messages through the control channel when available', async () => {
    await mount([
      client('control-client', ['telemetry.publish', 'session.summary', 'control.receive']),
    ]);
    await enterMessage('check production now');
    const send = host.querySelector<HTMLButtonElement>('[aria-label="Send message"]');
    await act(async () => send?.click());

    expect(postCommand).toHaveBeenCalledWith(
      'control-client',
      'steer',
      expect.objectContaining({
        sessionId: 'session-mobile',
        to: 'leader',
        body: 'check production now',
      }),
    );
    expect(postMailboxSend).not.toHaveBeenCalled();
  });

  it('falls back to durable mailbox delivery when live control is unavailable', async () => {
    await mount([client('mailbox-client', ['telemetry.publish', 'mailbox.serve'])]);
    await enterMessage('reply when ready');
    const send = host.querySelector<HTMLButtonElement>('[aria-label="Send message"]');
    await act(async () => send?.click());

    expect(postMailboxSend).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-mobile',
        sessionId: 'session-mobile',
        to: 'leader',
        body: 'reply when ready',
      }),
    );
    expect(postCommand).not.toHaveBeenCalled();
  });

  it('shows mailbox traffic and acknowledges it through the server action route', async () => {
    await mount([client('mailbox-client', ['telemetry.publish', 'mailbox.serve'])]);
    act(() => {
      useHqStore.setState({
        events: [
          {
            id: 'mail-event-1',
            type: 'mailbox.event',
            schemaVersion: 1,
            timestamp: NOW,
            clientId: 'mailbox-client',
            projectId: 'project-mobile',
            seq: 1,
            payload: {
              mailboxId: 'project-mobile:mailbox',
              action: 'message.sent',
              message: {
                mailId: 'mail-mobile-1',
                messageId: 'message-mobile-1',
                from: 'worker-1',
                to: 'leader',
                type: 'ask',
                subject: 'Need a deployment decision',
                priority: 'high',
                timestamp: NOW,
                completed: false,
                hasBody: true,
                bodyPreview: 'Production rollout is waiting.',
              },
            },
          },
        ],
      });
    });
    await act(async () => paneButton('Inbox').click());

    expect(host.textContent).toContain('Need a deployment decision');
    const acknowledge = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Acknowledge'),
    );
    await act(async () => acknowledge?.click());

    expect(authorizedFetch).toHaveBeenCalledWith(
      '/api/mailbox/messages/mail-mobile-1/action',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"action":"acknowledge"'),
      }),
    );
    expect(
      host.querySelector('[data-testid="mobile-mailbox-message"]')?.getAttribute('data-completed'),
    ).toBe('true');
  });

  it('opens a waiting agent from Attention directly in Console', async () => {
    await mount([
      client('control-client', ['telemetry.publish', 'session.summary', 'control.receive']),
    ]);
    const session = liveSession();
    session.agents[1] = { ...session.agents[1]!, status: 'waiting_user' };
    act(() => {
      useHqStore.setState((state) => ({
        snapshot: state.snapshot === null ? null : { ...state.snapshot, liveSessions: [session] },
      }));
    });
    await act(async () => paneButton('Attention').click());
    expect(host.textContent).toContain('worker · waiting_user');

    const open = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Open',
    );
    await act(async () => open?.click());

    expect(useHqStore.getState().selectedAgentId).toBe('worker-1');
    expect(paneButton('Console').getAttribute('data-selected')).toBe('true');
  });
});
