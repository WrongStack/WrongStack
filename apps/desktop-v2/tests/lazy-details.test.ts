// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '../src/engine-state';
import { LazyDetails } from '../src/LazyDetails';
import { LiveRunActivity, TurnTools } from '../src/TurnTools';
import { renderOpen } from './helpers/render-open';

vi.mock('../src/platform', () => ({}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const events = [
  { type: 'tool.started', payload: { id: 't1', name: 'read', input: { path: 'src/deep.ts' } } },
  {
    type: 'tool.executed',
    payload: { id: 't1', name: 'read', ok: true, output: 'the file body' },
  },
];

describe('collapsed run activity', () => {
  it('preserves reader expansion across live updates and completion', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const render = async (live: boolean, updated: readonly EngineEvent[] = events) => {
      await act(async () =>
        root.render(
          createElement(LiveRunActivity, {
            events: updated,
            live,
            onOpenFile: () => {},
          }),
        ),
      );
    };
    try {
      await render(true);
      const panel = host.querySelector('details');
      expect(panel?.open).toBe(true);
      if (!panel) throw new Error('Missing activity panel');
      panel.open = false;
      await act(async () => panel.dispatchEvent(new Event('toggle')));
      await render(true, [...events, { type: 'iteration.started', payload: { index: 1 } }]);
      expect(panel.open).toBe(false);
      await render(false);
      expect(panel.open).toBe(false);
      panel.open = true;
      await act(async () => panel.dispatchEvent(new Event('toggle')));
      await render(false);
      expect(panel.open).toBe(true);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('supports controlled expansion and reports requested changes', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const onOpenChange = vi.fn();
    const render = async (open: boolean) => {
      await act(async () =>
        root.render(
          createElement(LazyDetails, {
            open,
            onOpenChange,
            summary: createElement('summary', null, 'Controlled'),
            children: createElement('p', null, 'Retained body'),
          }),
        ),
      );
    };
    try {
      await render(false);
      const panel = host.querySelector('details');
      if (!panel) throw new Error('Missing disclosure');
      panel.open = true;
      await act(async () => panel.dispatchEvent(new Event('toggle')));
      expect(onOpenChange).toHaveBeenCalledWith(true);
      expect(panel.open).toBe(false);
      await render(true);
      expect(panel.open).toBe(true);
      expect(host.textContent).toContain('Retained body');
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('builds no tool details until it opens, then keeps them', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () =>
      root.render(
        createElement(LazyDetails, {
          summary: createElement('summary', null, 'Activity'),
          children: createElement('p', { id: 'body' }, 'heavy body'),
        }),
      ),
    );
    expect(host.querySelector('#body')).toBeNull();
    const details = host.querySelector('details')!;
    details.open = true;
    await act(async () => details.dispatchEvent(new Event('toggle')));
    expect(host.querySelector('#body')?.textContent).toBe('heavy body');
    details.open = false;
    await act(async () => details.dispatchEvent(new Event('toggle')));
    expect(host.querySelector('#body')).not.toBeNull();
    await act(async () => root.unmount());
  });

  it('leaves a finished turn and each tool row closed and empty, a live run open', () => {
    const finished = renderToStaticMarkup(
      createElement(TurnTools, {
        events,
        stats: { iterations: 1, prompt: 0, output: 0, cacheRead: 0 },
        onOpenFile: () => {},
      }),
    );
    expect(finished).toContain('turn-tools');
    expect(finished).not.toContain('activity-entry');
    const live = renderToStaticMarkup(
      createElement(LiveRunActivity, { events, onOpenFile: () => {}, live: true }),
    );
    expect(live).toContain('activity-entry');
    expect(live).not.toContain('the file body');
    expect(
      renderOpen(createElement(LiveRunActivity, { events, onOpenFile: () => {}, live: true })),
    ).toContain('the file body');
  });
});
