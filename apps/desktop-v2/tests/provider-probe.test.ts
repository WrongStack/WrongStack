// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ProviderProbe, probeOutcome } from '../src/ProviderProbe';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('describes a probe result without claiming more than reachability', () => {
  expect(
    probeOutcome({ ok: true, status: 'ok', httpStatus: 200, elapsedMs: 84, modelCount: 3 }),
  ).toBe('Reachable · HTTP 200 · 84 ms · 3 models listed');
  expect(probeOutcome({ ok: false, status: 'unreachable', detail: 'ECONNREFUSED' })).toBe(
    'Unreachable · ECONNREFUSED',
  );
  expect(probeOutcome({ ok: false, status: 'no_base_url' })).toBe(
    'No endpoint URL to check (a built-in provider)',
  );
});

it('includes the visible probe action in its accessible name in every state', async () => {
  await surfaceI18n.changeLanguage('en');
  const host = document.createElement('div');
  const root = createRoot(host);
  const reply = Promise.withResolvers<Record<string, unknown>>();
  const command = vi.fn(() => reply.promise);
  try {
    await act(async () =>
      root.render(createElement(ProviderProbe, { providerId: 'local', command })),
    );
    const button = host.querySelector('button')!;
    const name = () => button.getAttribute('aria-label');
    expect(button.textContent?.trim()).toBe('Check endpoint');
    expect(name()).toContain('Check endpoint');
    expect(name()).toContain('local');

    await act(async () => button.click());
    expect(command).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(true);
    expect(button.textContent?.trim()).toBe('Checking…');
    expect(name()).toContain('Checking…');

    await act(async () => reply.resolve({ ok: true, status: 'ok' }));
    expect(button.disabled).toBe(false);
    expect(name()).toContain('Check endpoint');
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Reachable');
  } finally {
    await act(async () => root.unmount());
  }
});
