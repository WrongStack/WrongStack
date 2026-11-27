/**
 * @vitest-environment jsdom
 *
 * FilePicker shows the files for its current query. The server answers requests
 * concurrently, so a reply for an older query can arrive last; replies name their
 * query and the picker drops the stale one.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Set<(msg: { type: string; payload: unknown }) => void>();
const requested: string[] = [];
const picked = vi.fn();
const client = {
  on: (_type: string, fn: (msg: { type: string; payload: unknown }) => void) => {
    handlers.add(fn);
    return () => handlers.delete(fn);
  },
  listFiles: (query?: string) => requested.push(query ?? ''),
};
vi.mock('@/hooks/useWebSocket', () => ({ useWebSocket: () => ({ client }) }));
vi.mock('@/lib/ws-client', () => ({ getWSClient: () => client }));
vi.mock('@/stores', () => ({
  useConfigStore: (sel: (s: { wsUrl: string }) => unknown) => sel({ wsUrl: 'ws://x' }),
}));
vi.mock('@/i18n', () => ({ useAppTranslation: () => ({ t: (k: string) => k }) }));

const { FilePicker } = await import('@/components/FilePicker');

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  handlers.clear();
  requested.length = 0;
  picked.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const render = (query: string, withDialog = false) =>
  act(async () => {
    root.render(
      <>
        {withDialog ? (
          <div role="dialog" aria-label="Foreground dialog">
            <button type="button">Dialog action</button>
          </div>
        ) : null}
        <FilePicker query={query} onPick={picked} onClose={() => {}} />
      </>,
    );
  });
const tick = () =>
  act(async () => {
    vi.advanceTimersByTime(100);
  });
const reply = (files: string[], query?: string) =>
  act(async () => {
    for (const fn of handlers)
      fn({ type: 'files.list', payload: { files, ...(query === undefined ? {} : { query }) } });
  });
const shown = () => [...container.querySelectorAll('button')].map((b) => b.textContent?.trim());
const pressTab = () => {
  const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  return event;
};

describe('FilePicker follows the current query', () => {
  it('control: in-order replies show the current query results', async () => {
    await render('sessioncomp');
    await tick();
    await render('se');
    await tick();
    await reply(['src/SessionComposer.tsx'], 'sessioncomp');
    await reply(['src/settings.ts', 'src/SessionComposer.tsx'], 'se');
    expect(requested).toEqual(['sessioncomp', 'se']);
    expect(shown()).toEqual(['src/settings.ts', 'src/SessionComposer.tsx']);
  });

  it('a late reply for an older query does not replace the current list', async () => {
    await render('sessioncomp');
    await tick();
    await render('se');
    await tick();
    await reply(['src/settings.ts', 'src/SessionComposer.tsx'], 'se');
    await reply(['src/SessionComposer.tsx'], 'sessioncomp');
    expect(shown()).toEqual(['src/settings.ts', 'src/SessionComposer.tsx']);
  });

  it('shows a reply without a query (older engine) as before', async () => {
    await render('se');
    await tick();
    await reply(['legacy.ts']);
    expect(shown()).toEqual(['legacy.ts']);
  });

  it('control: Tab selects the active file while no dialog is open', async () => {
    await render('se');
    await tick();
    await reply(['src/settings.ts'], 'se');
    const event = pressTab();
    expect(picked).toHaveBeenCalledWith('src/settings.ts');
    expect(event.defaultPrevented).toBe(true);
  });

  it('a foreground dialog owns Tab while the picker is open', async () => {
    await render('se', true);
    await tick();
    await reply(['src/settings.ts'], 'se');
    const event = pressTab();
    expect(event.defaultPrevented).toBe(false);
    expect(picked).not.toHaveBeenCalled();
  });
});
