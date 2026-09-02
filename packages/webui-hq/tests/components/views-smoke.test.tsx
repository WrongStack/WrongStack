/**
 * Every surface mounts.
 *
 * A cheap but broad net: each of the twelve views is rendered against an
 * EMPTY snapshot — the state a fresh browser is in before any telemetry
 * arrives, and the one most likely to hit an unguarded `[0]` or a `.map` on
 * something undefined. It asserts no layout; it asserts that nothing throws
 * and that each view says something rather than rendering blank.
 *
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type { ComponentType } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/data/api.js', () => ({
  // Views must survive an API that is not there yet; a rejected promise is
  // the realistic pre-connection state.
  fetchJson: vi.fn(() => Promise.reject(new Error('offline'))),
  authorizedFetch: vi.fn(() => Promise.resolve(new Response('{}', { status: 500 }))),
  postCommand: vi.fn(),
  postMailboxSend: vi.fn(),
}));

// React Flow measures its container; jsdom reports zeroes, which is fine, but
// it also needs ResizeObserver to exist at all.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

const { useHqStore } = await import('../../src/data/store/index.js');
const { snapshot } = await import('../fixtures/hq.js');

const { CockpitView } = await import('../../src/views/cockpit.js');
const { FleetMapView } = await import('../../src/views/fleet/index.js');
const { LiveConsoleView } = await import('../../src/views/console/index.js');
const { MailboxView } = await import('../../src/views/mailbox/index.js');
const { KanbanView } = await import('../../src/views/kanban/index.js');
const { AlertsView } = await import('../../src/views/alerts.js');
const { CostView } = await import('../../src/views/cost.js');
const { TrendsView } = await import('../../src/views/trends.js');
const { BrainView } = await import('../../src/views/brain.js');
const { WorktreeView } = await import('../../src/views/worktree.js');
const { ControlView } = await import('../../src/views/control/index.js');
const { SettingsView } = await import('../../src/views/settings/index.js');

const VIEWS: [string, ComponentType][] = [
  ['cockpit', CockpitView],
  ['fleet', FleetMapView],
  ['console', LiveConsoleView],
  ['mailbox', MailboxView],
  ['kanban', KanbanView],
  ['alerts', AlertsView],
  ['cost', CostView],
  ['trends', TrendsView],
  ['brain', BrainView],
  ['worktree', WorktreeView],
  ['control', ControlView],
  ['settings', SettingsView],
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  useHqStore.setState({
    snapshot: snapshot(),
    alerts: [],
    events: [],
    commandStatuses: [],
    activeView: 'cockpit',
    connected: true,
    authRequired: false,
    selectedSessionId: null,
    selectedAgentId: null,
    selectedClientId: null,
  });
});

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('view smoke', () => {
  it.each(VIEWS)('%s mounts against an empty snapshot', (_name, View) => {
    container = document.createElement('div');
    document.body.append(container);
    const created = createRoot(container);
    root = created;

    expect(() => {
      act(() => created.render(<View />));
    }).not.toThrow();

    expect(container.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it('mounts every view with a null snapshot too', () => {
    act(() => {
      useHqStore.setState({ snapshot: null });
    });
    for (const [, View] of VIEWS) {
      const host = document.createElement('div');
      document.body.append(host);
      const created = createRoot(host);
      expect(() => {
        act(() => created.render(<View />));
      }).not.toThrow();
      act(() => created.unmount());
      host.remove();
    }
  });
});
