import { afterEach, expect, it, vi } from 'vitest';
import { resolveAppSidebarLayout } from '../src/app-ui-state.js';
import type { HistoryEntry } from '../src/components/history.js';
import {
  type HistoryScrollController,
  ScrollableHistory,
} from '../src/components/scrollable-history.js';
import { createTestState } from './helpers/create-test-state.js';
import { key, makeHandler } from './helpers/key-handler-fixture.js';
import { type RealTtyView, renderRealTty } from './helpers/real-tty.js';

const entries: HistoryEntry[] = Array.from({ length: 30 }, (_, i) => ({
  id: i + 1,
  kind: 'user',
  text: `MSG-${String(i + 1).padStart(2, '0')}`,
}));
let view: RealTtyView | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

async function history(columns: number) {
  const ref = { current: null as HistoryScrollController | null };
  const tty = renderRealTty(
    <ScrollableHistory entries={entries} toolStream={null} viewportRows={10} controllerRef={ref} />,
    { columns, rows: 24 },
  );
  view = tty;
  await vi.waitFor(() => expect(tty.lastFrame()).toContain('MSG-30'));
  return { tty, ref };
}

it.each([80, 0, Number.NaN])(
  'routes wheel scrolling using the rendered viewport with a reported size of %s',
  async (dimension) => {
    const { ref } = await history(80);
    const fixture = makeHandler(createTestState({ viewportRows: 10 }), undefined, {
      terminalColumns: dimension,
      terminalRows: dimension === 80 ? 24 : dimension,
      termRows: dimension === 80 ? 24 : dimension,
      mainColumnWidth: 0,
      historyScrollRef: ref,
    });
    expect(ref.current?.isScrolled()).toBe(false);
    await fixture.handler(
      '',
      key({
        mouse: {
          kind: 'wheel',
          button: 'none',
          x: 10,
          y: 3,
          wheel: 1,
          shift: false,
          ctrl: false,
          meta: false,
          motion: false,
        },
      }),
    );
    await vi.waitFor(() => expect(ref.current?.isScrolled()).toBe(true));
  },
);

it.each([40, 120])(
  'keeps the scrollbar hit at the visible right edge after a shrink (main width %s)',
  async (mainColumnWidth) => {
    const { tty, ref } = await history(40);
    const fixture = makeHandler(createTestState({ viewportRows: 10 }), undefined, {
      terminalColumns: 40,
      terminalRows: 24,
      termRows: 24,
      mainColumnWidth,
      historyScrollRef: ref,
    });
    await fixture.handler(
      '',
      key({
        mouse: {
          kind: 'press',
          button: 'left',
          x: 40,
          y: 1,
          wheel: 0,
          shift: false,
          ctrl: false,
          meta: false,
          motion: false,
        },
      }),
    );
    await vi.waitFor(() => expect(tty.lastFrame()).toContain('MSG-01'));
  },
);

it.each([80, Number.NaN])(
  'ignores wheel reports outside the fallback screen when the reported width is %s',
  async (dimension) => {
    const { ref } = await history(80);
    const fixture = makeHandler(createTestState({ viewportRows: 10 }), undefined, {
      terminalColumns: dimension,
      terminalRows: 24,
      termRows: 24,
      mainColumnWidth: 0,
      historyScrollRef: ref,
    });
    await fixture.handler(
      '',
      key({
        mouse: {
          kind: 'wheel',
          button: 'none',
          x: 81,
          y: 3,
          wheel: 1,
          shift: false,
          ctrl: false,
          meta: false,
          motion: false,
        },
      }),
    );
    expect(ref.current?.isScrolled()).toBe(false);
  },
);

it('moves the caret through the displayed wrapped rows while terminal dimensions are unavailable', async () => {
  const draft = { buffer: 'wrapped text '.repeat(20), cursor: 'wrapped text '.repeat(20).length };
  const state = createTestState(draft);
  const normal = makeHandler(state, draft, {
    terminalColumns: 80,
    terminalRows: 24,
    termRows: 24,
    mainColumnWidth: 0,
  });
  const unavailable = makeHandler(state, draft, {
    terminalColumns: 0,
    terminalRows: 0,
    termRows: 0,
    mainColumnWidth: 0,
  });
  await normal.handler('', key({ upArrow: true }));
  await unavailable.handler('', key({ upArrow: true }));
  expect(normal.setDraft).toHaveBeenCalledTimes(1);
  expect(unavailable.setDraft.mock.calls).toEqual(normal.setDraft.mock.calls);
});

it('rejects a wheel report below the physical screen while the old root height is still pending', async () => {
  const { ref } = await history(80);
  const fixture = makeHandler(createTestState({ viewportRows: 30 }), undefined, {
    terminalColumns: 80,
    terminalRows: 24,
    termRows: 40,
    mainColumnWidth: 80,
    historyScrollRef: ref,
  });
  await fixture.handler(
    '',
    key({
      mouse: {
        kind: 'wheel',
        button: 'none',
        x: 10,
        y: 25,
        wheel: 1,
        shift: false,
        ctrl: false,
        meta: false,
        motion: false,
      },
    }),
  );
  expect(ref.current?.isScrolled()).toBe(false);
});

it.each([3, 25])('bounds sidebar wheel routing to the physical screen at row %s', async (y) => {
  const fixture = makeHandler(createTestState({ viewportRows: 30 }), undefined, {
    terminalColumns: 80,
    terminalRows: 24,
    termRows: 40,
    mainColumnWidth: 60,
  });
  await fixture.handler(
    '',
    key({
      mouse: {
        kind: 'wheel',
        button: 'none',
        x: 65,
        y,
        wheel: 1,
        shift: false,
        ctrl: false,
        meta: false,
        motion: false,
      },
    }),
  );
  const sidebarActions = fixture.dispatch.mock.calls.filter(
    ([action]) => action.type === 'sidebarScroll',
  );
  expect(sidebarActions).toHaveLength(y <= 24 ? 1 : 0);
});

it.each([0, Number.NaN])(
  'uses the same sidebar split as the renderer for an unavailable width of %s',
  (dimension) => {
    const state = createTestState();
    expect(resolveAppSidebarLayout(state, dimension, undefined, false)).toEqual(
      resolveAppSidebarLayout(state, 80, undefined, false),
    );
  },
);
