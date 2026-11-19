/**
 * @vitest-environment jsdom
 *
 * The composer's @-file list belongs to the query in the textarea. The server
 * answers requests concurrently, so a reply for an older query can arrive last;
 * replies name their query and the composer drops the stale one.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Frame = { type: string; payload?: Record<string, unknown> };
let transport: { onMessage: (f: Frame) => void; onState: (s: string) => void } | null = null;
const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];

vi.mock('../src/lib/transport.js', () => ({
  VibeTransport: class {
    constructor(opts: typeof transport) {
      transport = opts;
    }
    async connect() {}
    send(type: string, payload: Record<string, unknown> = {}) {
      sent.push({ type, payload });
      return true;
    }
    close() {}
  },
  TOKEN_KEY: 'k',
  STABLE_CONNECTION_MS: 10_000,
}));

const { useSession } = await import('../src/lib/use-session.js');
const { Composer } = await import('../src/components/composer.js');

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  transport = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // jsdom lacks scrollIntoView; the composer calls it to keep the active option visible.
  Element.prototype.scrollIntoView ??= () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  } as never;
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container.remove();
  vi.useRealTimers();
});

async function mountComposer() {
  function Harness() {
    const controller = useSession();
    return <Composer controller={controller} />;
  }
  await act(async () => root!.render(<Harness />));
  await act(async () => {
    transport!.onState('open');
    transport!.onMessage({
      type: 'session.start',
      payload: { id: 's1', sessionId: 's1', provider: 'p', model: 'm', running: false, cwd: '/p' },
    });
  });
}
async function type(value: string) {
  const textarea = container.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    vi.advanceTimersByTime(150);
  });
}
const reply = (files: string[], query?: string) =>
  act(async () =>
    transport!.onMessage({
      type: 'files.list',
      payload: { sessionId: 's1', files, ...(query === undefined ? {} : { query }) },
    }),
  );
const shown = () =>
  [...container.querySelectorAll('.file-picker [role="option"]')].map((el) =>
    el.textContent?.trim(),
  );
const queries = () => sent.filter((m) => m.type === 'files.list').map((m) => m.payload.query);

describe('composer file mentions follow the current query', () => {
  it('control: in-order replies show the current query results', async () => {
    await mountComposer();
    await type('@sessioncomp');
    await type('@se');
    await reply(['src/SessionComposer.tsx'], 'sessioncomp');
    await reply(['src/settings.ts', 'src/SessionComposer.tsx'], 'se');
    expect(shown()).toEqual(['src/settings.ts', 'src/SessionComposer.tsx']);
  });

  it('a late reply for an older query does not replace the current list', async () => {
    await mountComposer();
    await type('@sessioncomp');
    await type('@se');
    await reply(['src/settings.ts', 'src/SessionComposer.tsx'], 'se');
    await reply(['src/SessionComposer.tsx'], 'sessioncomp'); // older query, answered last
    expect(queries()).toEqual(['sessioncomp', 'se']);
    expect(shown()).toEqual(['src/settings.ts', 'src/SessionComposer.tsx']);
  });

  it('shows a reply without a query (older engine) as before', async () => {
    await mountComposer();
    await type('@se');
    await reply(['legacy.ts']);
    expect(shown()).toEqual(['legacy.ts']);
  });
});
