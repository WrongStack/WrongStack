/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectHistorySearch } from '../src/ProjectHistorySearch.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function makeReply(title: string) {
  return {
    contentSearch: {
      revision: 'rev-1',
      catalogRevision: 'cat-1',
      scanned: 1,
      total: 1,
      nextCursor: null,
      results: [
        {
          id: `sess-${title}`,
          title,
          matching: 1,
          provider: 'openai',
          model: 'gpt-5',
          revision: 'r1',
          hits: [{ messageIndex: 0, role: 'user', excerpt: `${title} excerpt` }],
        },
      ],
      errors: [],
    },
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
});

describe('ProjectHistorySearch Stop unlock and generation-guarded finally', () => {
  it('immediately unlocks form on Stop and prevents stopped request settlement from clearing busy on a restarted search', async () => {
    const firstGate = deferred<Record<string, unknown>>();
    const secondGate = deferred<Record<string, unknown>>();
    let calls = 0;

    await act(async () => {
      root!.render(
        <ProjectHistorySearch
          command={
            (async () => {
              calls += 1;
              return calls === 1 ? firstGate.promise : secondGate.promise;
            }) as never
          }
          onSelect={() => {}}
        />,
      );
    });

    const input = container!.querySelector('input') as HTMLInputElement;
    const form = container!.querySelector('form') as HTMLFormElement;

    await act(async () => {
      setInputValue(input, 'alpha');
    });
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(input.disabled).toBe(true);

    const stopBtn = Array.from(container!.querySelectorAll('button')).find(
      (b) => b.type === 'button',
    ) as HTMLButtonElement;
    expect(stopBtn).toBeDefined();

    await act(async () => {
      stopBtn.click();
    });
    expect(input.disabled).toBe(false);
    expect(container!.querySelector('progress')).toBeNull();

    // Start second search while firstGate is still pending
    await act(async () => {
      setInputValue(input, 'beta');
    });
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(calls).toBe(2);
    expect(input.disabled).toBe(true);

    // Stopped first request settles late — must NOT clear busy on active second search
    await act(async () => {
      firstGate.reject(new Error('STALE_ERR'));
    });
    expect(input.disabled).toBe(true);
    expect(container!.textContent).not.toContain('STALE_ERR');

    await act(async () => {
      secondGate.resolve(makeReply('SecondSearchHit'));
    });
    expect(input.disabled).toBe(false);
    expect(container!.textContent).toContain('SecondSearchHit');
  });
});
