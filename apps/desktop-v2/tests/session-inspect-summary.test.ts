// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { SessionInspectSummary } from '../src/SessionInspectSummary';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const inspected = {
  id: 's1',
  tokenTotal: 12_000,
  messageCount: 14,
  iterationCount: 6,
  toolCallCount: 9,
  toolErrorCount: 1,
  fileChangeCount: 2,
  compactionCount: 0,
  outcome: 'completed',
  toolBreakdown: { read: 2, edit: 5, bash: 2 },
  events: [
    { ts: '2026-11-04T10:00:00.000Z', type: 'tool', label: 'edit src/a.ts', detail: 'ok' },
    { ts: '2026-11-04T10:01:00.000Z', type: 'compaction', label: 'Context compacted', detail: '' },
  ],
  fileEvents: [{ operation: 'create', filePath: 'src/a.ts', toolName: 'write', ts: '' }],
};

async function open(command = vi.fn(async () => inspected)) {
  const host = document.createElement('div');
  act(() => createRoot(host).render(createElement(SessionInspectSummary, { id: 's1', command })));
  const details = host.querySelector('details') as HTMLDetailsElement;
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
  return { host, command, details };
}

describe('recorded session summary', () => {
  it('reads nothing until it is opened, then reads the session once', async () => {
    const { command, details } = await open();
    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith('session.inspect', { id: 's1' }, ['session.inspect']);
    await act(async () => details.dispatchEvent(new Event('toggle')));
    expect(command).toHaveBeenCalledTimes(1);
  });

  it('shows the totals, tools by use, file changes and the events', async () => {
    const { host } = await open();
    const stats = [...host.querySelectorAll('.inspect-stats > div')].map((row) => row.textContent);
    expect(stats).toContain(`Tokens${(12_000).toLocaleString('en')}`);
    expect(stats).toContain('Tool calls9 · 1 failed');
    expect(host.textContent).toContain('Outcome: completed');
    const tools = [...host.querySelectorAll('[aria-label="Tool breakdown"] li')].map(
      (row) => row.textContent,
    );
    expect(tools).toEqual(['edit5', 'read2', 'bash2']);
    expect(host.querySelector('[aria-label="File changes"]')?.textContent).toContain(
      'src/a.tswriteCreated',
    );
    expect(host.textContent).toContain('Event timeline · 2 / 2');
  });

  it('filters the timeline by label or type', async () => {
    const { host } = await open();
    const input = host.querySelector('input[type="search"]') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'compaction',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.textContent).toContain('Event timeline · 1 / 2');
    expect(host.querySelectorAll('[aria-label="Event timeline"] li')).toHaveLength(1);
  });

  it('reports a failed read', async () => {
    const { host } = await open(
      vi.fn(async () => {
        throw new Error('engine is not connected');
      }),
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('engine is not connected');
  });
});
