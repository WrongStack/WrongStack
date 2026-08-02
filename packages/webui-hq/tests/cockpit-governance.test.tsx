/** @vitest-environment jsdom */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type { HqSnapshot } from '@wrongstack/core/hq/protocol';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchJsonMock = vi.hoisted(() => vi.fn());
vi.mock('../src/store.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchJson: fetchJsonMock };
});

import { useHqStore } from '../src/store.js';
import { CockpitView } from '../src/views/cockpit.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  fetchJsonMock.mockImplementation((url: string) =>
    Promise.resolve(
      url === '/api/system/health'
        ? {
            status: 'healthy',
            uptime: { serverTime: '2026-08-02T12:00:00.000Z', eventLogSize: 0 },
            stores: { events: 'ok', timeseries: 'ok', kanban: 'ok' },
            connections: { total: 1, active: 1, stale: 0 },
          }
        : { active: [], history: [] },
    ),
  );
  useHqStore.setState({ snapshot: null, alerts: [], selectedClientId: null, connected: true });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function mount(snapshot: HqSnapshot): Promise<void> {
  useHqStore.setState({ snapshot });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(CockpitView));
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Cockpit governance advisory', () => {
  it('shows project-owner warnings as advisory while execution continues', async () => {
    await mount({
      generatedAt: '2026-08-02T12:00:00.000Z',
      clients: [],
      sessions: [],
      fleets: [],
      mailboxes: [],
      projects: [
        {
          projectId: 'project-1',
          projectName: 'WrongStack',
          projectRootDisplay: 'D:/project',
          machineIds: ['machine-1'],
          activeClients: 1,
          activeSessions: 0,
          activeSubagents: 0,
          totalCostUsd: 0,
          lastActivityAt: '2026-08-02T12:00:00.000Z',
          status: 'active',
          governance: {
            schemaVersion: 1,
            projectId: 'project-1',
            observedAt: '2026-08-02T12:00:00.000Z',
            available: true,
            signal: {
              level: 'warning',
              code: 'attachment_broker_degraded',
              operatorAction: 'investigate',
              executionDisposition: 'continue',
            },
          },
        },
      ],
      totals: {
        activeProjects: 1,
        activeClients: 1,
        activeSessions: 0,
        activeSubagents: 0,
        unreadMailboxMessages: 0,
        incompleteMailboxMessages: 0,
        totalCostUsd: 0,
      },
    });

    expect(container?.textContent).toContain('1 governance advisories');
    expect(container?.textContent).toContain('Governance Advisory');
    expect(container?.textContent).toContain('attachment_broker_degraded');
    expect(container?.textContent).toContain('continue');
    const buttons = Array.from(container?.querySelectorAll('button') ?? []);
    expect(buttons.every((button) => !button.textContent?.toLowerCase().includes('stop'))).toBe(
      true,
    );
  });
});
