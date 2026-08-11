/** @vitest-environment jsdom */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type { HqSnapshot } from '@wrongstack/core/hq';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchJsonMock = vi.hoisted(() => vi.fn());
vi.mock('../src/store.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchJson: fetchJsonMock };
});

import { useHqStore } from '../src/store.js';
import { resetHqLocalPrefs } from '../src/stores/hq-local-prefs.js';
import { ControlView } from '../src/views/control.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function controlSnapshot(): HqSnapshot {
  return {
    generatedAt: '2026-08-11T12:00:00.000Z',
    clients: [
      {
        clientId: 'client-control-1',
        kind: 'tui',
        machineId: 'machine-1',
        hostname: 'devbox',
        connected: true,
        lastSeenAt: '2026-08-11T12:00:00.000Z',
        projectId: 'project-1',
        capabilities: ['control.receive'],
      },
    ],
    projects: [
      {
        projectId: 'project-1',
        projectName: 'WrongStack',
        projectRootDisplay: 'D:/Codebox/PROJECTS/WrongStack',
        machineIds: ['machine-1'],
        activeClients: 1,
        activeSessions: 1,
        activeSubagents: 0,
        totalCostUsd: 0,
        lastActivityAt: '2026-08-11T12:00:00.000Z',
        status: 'active',
      },
    ],
    sessions: [],
    fleets: [],
    mailboxes: [],
    liveSessions: [],
    totals: {
      activeProjects: 1,
      activeClients: 1,
      activeSessions: 1,
      activeSubagents: 0,
      unreadMailboxMessages: 0,
      incompleteMailboxMessages: 0,
      totalCostUsd: 0,
    },
  };
}

beforeEach(() => {
  fetchJsonMock.mockResolvedValue({ commands: [] });
  resetHqLocalPrefs();
  useHqStore.setState({
    snapshot: controlSnapshot(),
    selectedClientId: null,
    commandStatuses: [],
    activeView: 'control',
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function mountControl(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(ControlView));
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Control command workspace', () => {
  it('turns an unavailable command plane into an actionable fleet empty state', async () => {
    const snapshot = controlSnapshot();
    snapshot.clients = [];
    useHqStore.setState({ snapshot });
    await mountControl();

    expect(container?.querySelector('.hq-control-zero')).not.toBeNull();
    expect(container?.textContent).toContain('No command-ready clients');
    const fleetButton = Array.from(
      container?.querySelectorAll<HTMLButtonElement>('button') ?? [],
    ).find((button) => button.textContent?.trim() === 'Inspect Fleet Map');
    expect(fleetButton).toBeDefined();
    act(() => fleetButton?.click());
    expect(useHqStore.getState().activeView).toBe('fleet');
  });

  it('renders the guarded command plane and advances destructive commands to preview', async () => {
    await mountControl();

    const screen = container?.querySelector('.hq-control-screen');
    expect(screen?.getAttribute('data-stage')).toBe('compose');
    expect(screen?.getAttribute('data-risk')).toBe('normal');
    expect(container?.textContent).toContain('Remote execution, with guardrails');
    expect(container?.textContent).toContain('1targets');

    const abort = Array.from(
      container?.querySelectorAll<HTMLButtonElement>('.hq-control-type') ?? [],
    ).find((button) => button.textContent?.trim() === 'abort');
    expect(abort).toBeDefined();
    act(() => abort?.click());

    expect(screen?.getAttribute('data-risk')).toBe('danger');
    expect(container?.textContent).toContain('danger risk');

    const preview = Array.from(container?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Preview Command',
    );
    expect(preview).toBeDefined();
    act(() => preview?.click());

    expect(screen?.getAttribute('data-stage')).toBe('preview');
    expect(container?.querySelector('#hq-control-confirm')).not.toBeNull();
    expect(container?.textContent).toContain('payload preview');
  });
});
