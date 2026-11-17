// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
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
