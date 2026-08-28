/**
 * LiveMailboxView interaction tests — verify the filter UI wires through to
 * `mailboxLiveFilterReducer` and that the rendered timeline reflects the
 * active filter set.
 *
 * The view accepts optional `snapshot` + `events` props so the test bypasses
 * `useHqStore` (and therefore the WS client). The reducer is exercised
 * end-to-end via real DOM events through `react-dom/client` + jsdom.
 *
 * @vitest-environment jsdom
 */
// React 19's `act` checks this global before allowing itself to run. Vitest's
// jsdom environment does not set it for us, so enable it here before the
// React runtime is loaded.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type {
  HqEventEnvelope,
  HqMailboxEventPayload,
  HqMailboxMessageSummary,
} from '@wrongstack/core/hq';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LiveMailboxView } from '../src/views/mailbox-live-view.js';

interface MountHandle {
  root: Root;
  container: HTMLDivElement;
}

function mount(props: Parameters<typeof LiveMailboxView>[0] = {}): MountHandle {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(LiveMailboxView as any, props));
  });
  return { root, container };
}

function unmount(handle: MountHandle): void {
  act(() => {
    handle.root.unmount();
  });
  handle.container.remove();
}

function queryChip(container: HTMLElement, label: string): HTMLButtonElement | null {
  const chips = Array.from(container.querySelectorAll<HTMLButtonElement>('button.hq-filter-chip'));
  return chips.find((btn) => btn.textContent?.trim() === label) ?? null;
}

function counterText(container: HTMLElement): string {
  const title = container.querySelector<HTMLElement>('.hq-card-title');
  return title?.textContent?.trim() ?? '';
}

function rowCount(container: HTMLElement): number {
  return container.querySelectorAll<HTMLElement>('.hq-live-feed .hq-msg').length;
}

function makeMessage(overrides: Partial<HqMailboxMessageSummary>): HqMailboxMessageSummary {
  return {
    mailId: `mail-${overrides.mailId ?? 'default'}`,
    messageId: `m-${overrides.messageId ?? 'default'}`,
    from: 'leader',
    to: '*',
    type: 'note',
    subject: 'default',
    priority: 'normal',
    timestamp: '2026-07-03T08:00:00.000Z',
    completed: false,
    hasBody: false,
    ...overrides,
    scope: overrides.scope ?? 'project',
  };
}

function makeMailboxEvent(
  mailId: string,
  message: HqMailboxMessageSummary,
  projectId = 'demo',
): HqEventEnvelope<HqMailboxEventPayload> {
  return {
    id: `evt-${mailId}`,
    type: 'mailbox.event',
    schemaVersion: 1,
    timestamp: '2026-07-03T08:00:00.000Z',
    clientId: 'client',
    projectId,
    seq: 1,
    payload: {
      mailboxId: `${projectId}:mailbox`,
      action: 'message.sent',
      message,
    },
  };
}

interface Fixture {
  events: HqEventEnvelope[];
  ask: HqMailboxMessageSummary;
  note: HqMailboxMessageSummary;
  high: HqMailboxMessageSummary;
  done: HqMailboxMessageSummary;
}

function buildFixture(): Fixture {
  const ask = makeMessage({
    mailId: 'ask',
    messageId: 'ask',
    type: 'ask',
    subject: 'deploy please',
    from: 'team-lead',
    priority: 'normal',
    timestamp: '2026-07-03T08:30:00.000Z',
  });
  const note = makeMessage({
    mailId: 'note',
    messageId: 'note',
    type: 'note',
    subject: 'note a',
    from: 'agent-1',
    timestamp: '2026-07-03T08:10:00.000Z',
  });
  const high = makeMessage({
    mailId: 'high',
    messageId: 'high',
    type: 'steer',
    subject: 'urgent pivot',
    from: 'agent-2',
    priority: 'high',
    timestamp: '2026-07-03T09:00:00.000Z',
  });
  const done = makeMessage({
    mailId: 'done',
    messageId: 'done',
    type: 'result',
    subject: 'task complete',
    from: 'agent-3',
    priority: 'low',
    timestamp: '2026-07-03T07:30:00.000Z',
    completed: true,
    completedBy: 'team-lead',
  });
  return {
    events: [
      makeMailboxEvent(ask.mailId, ask),
      makeMailboxEvent(note.mailId, note),
      makeMailboxEvent(high.mailId, high),
      makeMailboxEvent(done.mailId, done),
    ],
    ask,
    note,
    high,
    done,
  };
}

describe('LiveMailboxView', () => {
  let handle: MountHandle;
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture();
  });

  afterEach(() => {
    if (handle) unmount(handle);
  });

  it('renders every message when no filters are active', () => {
    handle = mount({ events: fixture.events });
    expect(rowCount(handle.container)).toBe(4);
    expect(counterText(handle.container)).toContain('4 of 4');
  });

  it('filters by type chip', () => {
    handle = mount({ events: fixture.events });
    const askChip = queryChip(handle.container, 'ask');
    expect(askChip).not.toBeNull();
    act(() => {
      askChip?.click();
    });
    expect(rowCount(handle.container)).toBe(1);
    expect(counterText(handle.container)).toContain('1 of 1');
    expect(askChip?.className).toContain('selected');
  });

  it('filters by priority chip and combines with a type filter', () => {
    handle = mount({ events: fixture.events });
    const highChip = queryChip(handle.container, 'high');
    const steerChip = queryChip(handle.container, 'steer');
    act(() => {
      highChip?.click();
      steerChip?.click();
    });
    // Only the high-priority `steer` matches (priority=high, type=steer);
    // the `ask` message is normal priority and is filtered out.
    expect(rowCount(handle.container)).toBe(1);
    expect(counterText(handle.container)).toContain('1 of 1');
  });

  it('clears all active filters when the Clear filters button is pressed', () => {
    handle = mount({ events: fixture.events });
    const steerChip = queryChip(handle.container, 'steer');
    const highChip = queryChip(handle.container, 'high');
    act(() => {
      steerChip?.click();
      highChip?.click();
    });
    // Only the high-priority `steer` message survives.
    expect(rowCount(handle.container)).toBe(1);

    const clearButton = Array.from(
      handle.container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((btn) => btn.textContent?.trim().startsWith('Clear filters'));
    expect(clearButton).toBeDefined();
    expect(clearButton?.disabled).toBe(false);

    act(() => {
      clearButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(rowCount(handle.container)).toBe(4);
    expect(queryChip(handle.container, 'steer')?.className.includes('selected')).toBe(false);
    expect(queryChip(handle.container, 'high')?.className.includes('selected')).toBe(false);
  });

  it('hides completed messages when include-completed is unchecked', () => {
    handle = mount({ events: fixture.events });
    expect(rowCount(handle.container)).toBe(4);
    const checkbox = handle.container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox?.checked).toBe(true);
    act(() => {
      checkbox?.click();
    });
    expect(checkbox?.checked).toBe(false);
    expect(rowCount(handle.container)).toBe(3);
  });

  it('searches across subject/from/body and narrows the timeline', () => {
    handle = mount({ events: fixture.events });
    const searchInput = handle.container.querySelector<HTMLInputElement>('#mailbox-live-query');
    expect(searchInput).not.toBeNull();
    act(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      nativeSetter?.call(searchInput, 'deploy');
      searchInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(rowCount(handle.container)).toBe(1);
    expect(counterText(handle.container)).toContain('1 of 1');
  });

  it('shows an empty-state hint when no messages match the active filter', () => {
    handle = mount({ events: fixture.events });
    const reviewChip = queryChip(handle.container, 'review');
    act(() => {
      reviewChip?.click();
    });
    expect(rowCount(handle.container)).toBe(0);
    const empty = handle.container.querySelector<HTMLElement>('.hq-empty');
    expect(empty?.textContent).toMatch(/No mailbox activity matches/i);
  });

  it('lists one chip per project visible in the event stream', () => {
    const projectA = makeMessage({ mailId: 'pa', messageId: 'pa', subject: 'A', type: 'note' });
    const projectB = makeMessage({ mailId: 'pb', messageId: 'pb', subject: 'B', type: 'note' });
    handle = mount({
      events: [
        makeMailboxEvent(projectA.mailId, projectA, 'proj-a'),
        makeMailboxEvent(projectB.mailId, projectB, 'proj-b'),
      ],
    });
    expect(queryChip(handle.container, 'proj-a (1)')).not.toBeNull();
    expect(queryChip(handle.container, 'proj-b (1)')).not.toBeNull();
  });
});

// Silence unused-import warnings if the file ever drops a fixture.
const _el: ReactElement | null = null;
void _el;
