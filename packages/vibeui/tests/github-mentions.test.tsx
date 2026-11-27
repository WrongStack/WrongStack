/**
 * @vitest-environment jsdom
 *
 * `#` in the composer lists the session project's GitHub pull requests and
 * issues from the host's /api/github route and inserts the picked item's URL.
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

const list = {
  status: 'ok',
  repository: 'octo/repo',
  tokenSource: 'gh',
  projectRoot: '/p',
  pulls: [
    {
      number: 128,
      title: 'Add GitHub view',
      url: 'https://github.com/octo/repo/pull/128',
      author: 'octocat',
      labels: [],
      comments: 0,
      createdAt: '',
      updatedAt: '',
      draft: false,
      headRef: 'feat',
      baseRef: 'main',
    },
  ],
  issues: [],
  truncated: { pulls: false, issues: false },
  fetchedAt: '',
};
const fetcher = vi.fn(async (url: string) => {
  const body = url.startsWith('/api/github/item')
    ? url.includes('number=453')
      ? {
          status: 'ok',
          repository: 'octo/repo',
          tokenSource: 'gh',
          item: {
            kind: 'pull',
            number: 453,
            title: 'Ship the release gate',
            url: 'https://github.com/octo/repo/pull/453',
            author: 'releaser',
          },
        }
      : { status: 'not-found', repository: 'octo/repo', tokenSource: 'gh', item: null }
    : list;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetcher);
  fetcher.mockClear();
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
  vi.unstubAllGlobals();
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
const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
const textarea = () =>
  container.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement;
const options = () =>
  [...container.querySelectorAll('[aria-label="Pull requests and issues"] [role="option"]')].map(
    (el) => el.textContent?.replace(/\s+/g, ' ').trim(),
  );
const press = (key: string) =>
  act(async () => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });

describe('composer # mentions of GitHub items', () => {
  it('lists open items for the session and inserts the picked URL', async () => {
    await mountComposer();
    await type('review #12');
    await settle();
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('/api/github?sessionId=s1');
    expect(options()).toEqual(['#128 Add GitHub viewPull request · octocat']);
    await press('Enter');
    expect(textarea().value).toBe('review https://github.com/octo/repo/pull/128 ');
    expect(sent.some((m) => m.type === 'user_message' || m.type === 'chat')).toBe(false);
  });

  it('looks up an exact number that is not open', async () => {
    await mountComposer();
    await type('see #453');
    await settle();
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await settle();
    expect(options()).toEqual(['#453 Ship the release gatePull request · releaser']);
    expect(
      fetcher.mock.calls.some(([url]) =>
        String(url).startsWith('/api/github/item?kind=pull&number=453&parts=none&sessionId=s1'),
      ),
    ).toBe(true);
  });

  it('stays closed when nothing matches', async () => {
    await mountComposer();
    await type('step #3');
    await settle();
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await settle();
    expect(options()).toEqual([]);
    expect(container.querySelector('[aria-label="Matching pull requests and issues"]')).toBeNull();
  });
});
