// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { SessionActivity } from '../src/SessionActivity';
import { activityRows } from '../src/session-activity-model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const events = [
  { type: 'tool.executed', payload: { id: 'orphan', name: 'glob', ok: true } },
  { type: 'iteration.started', payload: { index: 0 } },
  { type: 'tool.started', payload: { id: 'one', name: 'read', input: { path: 'first.ts' } } },
  { type: 'provider.thinking_delta', payload: { text: 'First reasoning' } },
  { type: 'provider.retry', payload: { providerId: 'fixture', attempt: 1 } },
  { type: 'iteration.completed', payload: { index: 0 } },
  { type: 'iteration.started', payload: { index: 1 } },
  { type: 'tool.started', payload: { id: 'two', name: 'edit' } },
  {
    type: 'tool.executed',
    payload: { id: 'one', name: 'read', ok: false, output: 'Late failure' },
  },
  { type: 'provider.thinking_delta', payload: { text: 'Second reasoning' } },
  { type: 'run.result', payload: { status: 'aborted' } },
];

describe('activity grouped by iteration', () => {
  it('keeps late results, reasoning and retries with their originating iteration', () => {
    const rows = activityRows(events);
    const first = rows.find((row) => row.title === 'Iteration 1');
    const second = rows.find((row) => row.title === 'Iteration 2');
    expect(first?.status).toBe('done');
    expect(second?.status).toBe('aborted');
    expect(rows.filter((row) => row.iterationId === first?.id).map((row) => row.title)).toEqual([
      'Iteration 1',
      'read',
      'Thinking',
      'fixture retry 1',
    ]);
    expect(rows.find((row) => row.title === 'read')).toMatchObject({
      status: 'failed',
      output: 'Late failure',
    });
    expect(rows.find((row) => row.title === 'edit')).toMatchObject({
      status: 'aborted',
      iterationId: second?.id,
    });
    expect(rows.find((row) => row.title === 'Run stopped')?.iterationId).toBeUndefined();
    expect(rows.find((row) => row.title === 'glob')?.iterationId).toBeUndefined();
  });

  it('separates process boundaries and reused tool IDs without inventing iterations', () => {
    const rows = activityRows([
      ...events.slice(1, 3),
      { type: 'desktop.engine_boundary', payload: {} },
      { type: 'tool.started', payload: { id: 'one', name: 'read' } },
      { type: 'iteration.started', payload: { index: 0 } },
      { type: 'tool.started', payload: { id: 'new', name: 'write' } },
    ]);
    const reads = rows.filter((row) => row.title === 'read');
    expect(reads).toHaveLength(2);
    expect(reads[0]?.status).toBe('aborted');
    expect(reads[1]?.iterationId).toBeUndefined();
    expect(rows.find((row) => row.title === 'write')?.iterationId).not.toBe(reads[0]?.iterationId);
  });

  it('renders independent iteration disclosures, retains children and groups filtered calls', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const render = async (compact = false) => {
      await act(async () =>
        root.render(createElement(SessionActivity, { events, compact, onOpenFile: () => {} })),
      );
    };
    try {
      await render();
      const groups = host.querySelectorAll<HTMLDetailsElement>('.activity-iteration');
      expect(groups).toHaveLength(2);
      expect(groups[0]?.textContent).toContain('read');
      expect(groups[0]?.textContent).not.toContain('edit');
      expect(groups[1]?.textContent).toContain('edit');
      expect(host.querySelector('.activity-entry > summary')?.textContent).not.toContain(
        'Iteration',
      );
      expect(
        host.querySelector('.activity-kind-run.activity-aborted')?.closest('.activity-iteration'),
      ).toBeNull();
      const first = groups[0];
      if (!first) throw new Error('Missing first iteration');
      first.open = false;
      await act(async () => first.dispatchEvent(new Event('toggle')));
      await render();
      expect(first.open).toBe(false);
      expect(groups[1]?.open).toBe(true);
      const tools = [...host.querySelectorAll('nav button')].find(
        (button) => button.textContent === 'Tools',
      );
      if (!(tools instanceof HTMLButtonElement)) throw new Error('Missing tool filter');
      await act(async () => tools.click());
      expect(host.querySelectorAll('.activity-iteration')).toHaveLength(2);
      expect(host.querySelectorAll('.activity-kind-reasoning')).toHaveLength(0);
      expect(host.querySelectorAll('.activity-kind-run')).toHaveLength(0);
      expect(host.querySelectorAll('.activity-kind-tool')).toHaveLength(3);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
