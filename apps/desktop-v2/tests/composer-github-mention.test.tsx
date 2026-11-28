/**
 * @vitest-environment jsdom
 *
 * `#` in the desktop composer lists the project's GitHub pull requests and
 * issues through the project engine, inserts the picked item's URL, and takes
 * keys only while it has matches.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EngineHttp } from '../src/engine-http';
import { surfaceI18n } from '../src/surface-i18n';
import { useComposerGitHub } from '../src/useComposerGitHub';

const list = {
  status: 'ok',
  repository: 'octo/repo',
  pulls: [
    {
      number: 128,
      title: 'Add GitHub view',
      url: 'https://github.com/octo/repo/pull/128',
      author: 'octocat',
      draft: false,
    },
  ],
  issues: [],
};
const http = vi.fn(async (resource: string) => {
  if (resource === '/api/github') return list;
  if (resource === '/api/github/item?kind=pull&number=453&parts=none')
    return {
      status: 'ok',
      item: {
        kind: 'pull',
        number: 453,
        title: 'Ship the release gate',
        url: 'https://github.com/octo/repo/pull/453',
        author: 'releaser',
      },
    };
  return { status: 'not-found', item: null };
}) as unknown as EngineHttp & ReturnType<typeof vi.fn>;

let root: Root | null = null;
let container: HTMLDivElement;
let api: ReturnType<typeof useComposerGitHub> | null = null;
const onInsert = vi.fn();
const onDismiss = vi.fn();

function Harness({ draft, suppressed = false }: { draft: string; suppressed?: boolean }) {
  api = useComposerGitHub({
    draft,
    cursor: draft.length,
    projectId: 'p1',
    http,
    suppressed,
    onInsert,
    onDismiss,
  });
  return api.popup;
}

beforeAll(async () => {
  await surfaceI18n.changeLanguage('en');
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  onInsert.mockClear();
  onDismiss.mockClear();
  http.mockClear();
});

async function render(draft: string, suppressed = false) {
  if (!root) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => root!.render(createElement(Harness, { draft, suppressed })));
  for (let i = 0; i < 6; i++) await act(async () => Promise.resolve());
}

const options = () =>
  [...container.querySelectorAll('[role="option"]')].map((el) =>
    el.textContent?.replace(/\s+/g, ' ').trim(),
  );

describe('desktop composer # mentions', () => {
  it('lists open items and inserts the picked URL on Enter', async () => {
    root = null;
    await render('review #12');
    expect(http).toHaveBeenCalledWith('/api/github');
    expect(options()).toEqual(['#128 Add GitHub viewPull request · octocat']);
    let handled = false;
    await act(async () => {
      handled = api!.onKey('Enter', false);
    });
    expect(handled).toBe(true);
    expect(onInsert).toHaveBeenCalledWith('review https://github.com/octo/repo/pull/128 ', 45);
  });

  it('leaves Enter to the composer when nothing matches', async () => {
    root = null;
    await render('step #3');
    expect(options()).toEqual([]);
    expect(api!.onKey('Enter', false)).toBe(false);
    expect(onInsert).not.toHaveBeenCalled();
  });

  it('stays out of the way while another list owns the keys', async () => {
    root = null;
    await render('review #12', true);
    expect(http).not.toHaveBeenCalled();
    expect(api!.onKey('Enter', false)).toBe(false);
  });

  it('looks up an exact number that is not open', async () => {
    vi.useFakeTimers();
    try {
      root = null;
      await render('see #453');
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      for (let i = 0; i < 6; i++) await act(async () => Promise.resolve());
      expect(options()).toEqual(['#453 Ship the release gatePull request · releaser']);
    } finally {
      vi.useRealTimers();
    }
  });
});
