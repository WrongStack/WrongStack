import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { Entry, type HistoryEntry } from '../src/components/history.js';
import { memoryLifecycleEntry } from '../src/memory-lifecycle-entry.js';

function renderLifecycle(
  event: string,
  payload: Record<string, unknown>,
): { frame: string; lifecycle: NonNullable<ReturnType<typeof memoryLifecycleEntry>> } {
  const lifecycle = memoryLifecycleEntry(event, payload);
  expect(lifecycle).not.toBeNull();
  const entry: HistoryEntry = { id: 1, kind: 'memory-lifecycle', ...lifecycle! };
  const view = render(React.createElement(Entry, { entry, termWidth: 120 }));
  const frame = view.lastFrame() ?? '';
  view.unmount();
  return { frame, lifecycle: lifecycle! };
}

describe('memory lifecycle timeline', () => {
  it('renders an entered memory as a one-liner with action chrome, not a MEMORY title', () => {
    const { frame, lifecycle } = renderLifecycle('memory.accepted', {
      memoryId: '01M23BD8XFJJPFFVAQB98JY74Y',
      kind: 'bug_root_cause',
      persistence: 'long_lived',
      confidence: 1,
      freshness: 1,
    });

    expect(lifecycle.action).toBe('entered');
    expect(lifecycle.label).toBe('01M23BD8XFJJPFFVAQB98JY74Y');
    const flat = frame.replace(/\s+/g, ' ');
    expect(flat).toContain('🧠 ENTERED');
    expect(flat).toContain('01M23BD8XFJJPFFVAQB98JY74Y');
    expect(flat).toContain('bug_root_cause · long_lived · confidence 1.00 · freshness 1.00');
    expect(flat).not.toContain('MEMORY');
    expect(frame).not.toContain('↳');
  });

  it('formats and renders a grounded relationship event compactly', () => {
    const { frame } = renderLifecycle('memory.graph_edge_added', {
      from: 'mem:mem_auth_contract',
      to: 'mem:mem_refresh_workflow',
      relation: 'same_topic',
      evidence: ['tag:refresh-token'],
    });

    expect(frame).toContain('RELATED');
    expect(frame).toContain('mem_auth_contract');
    expect(frame).toContain('same_topic');
    expect(frame).toContain('why: tag:refresh-token');
    expect(frame).not.toContain('MEMORY');
  });

  it('keeps non-memory graph scaffolding out of the TUI timeline', () => {
    expect(
      memoryLifecycleEntry('memory.graph_edge_added', {
        from: 'file:src/auth.ts',
        to: 'dir:src',
        relation: 'related_to',
      }),
    ).toBeNull();
  });
});
