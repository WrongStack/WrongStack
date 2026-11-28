// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderQuotas } from '../src/components/provider-quotas';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const controller = {
  state: { id: 's1', provider: 'openai', cwd: '/demo' },
  connection: 'open',
  send: () => true,
  subscribe: () => () => {},
} as never;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.useRealTimers();
});

describe('quota refresh errors (WCAG 4.1.3)', () => {
  it('announces a refresh timeout with role="alert"', async () => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(ProviderQuotas, { controller }));
    });

    const summary = host.querySelector<HTMLButtonElement>('.quota-summary');
    expect(summary, 'quota summary renders').not.toBeNull();
    await act(async () => summary!.click());
    const refresh = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Refresh quotas'),
    );
    expect(refresh, 'refresh action renders').not.toBeNull();
    expect(refresh!.disabled, 'refresh is enabled').toBe(false);

    await act(async () => refresh!.click());
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });

    const error = [
      ...document.querySelectorAll<HTMLElement>('[role="status"], [role="alert"]'),
    ].find((node) => node.textContent?.includes('Refresh was not confirmed'));
    expect(error, 'timeout error renders').not.toBeNull();
    expect(error!.getAttribute('role')).toBe('alert');
  });
});
