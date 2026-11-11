// @vitest-environment jsdom
import type { ConfirmOptions, SurfaceHost } from '@wrongstack/project-surfaces/host';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SurfaceFrame, useSurfaceConfirm } from '../src/SurfaceFrame';
import { surfaceI18n } from '../src/surface-i18n';

vi.mock('../src/useEngine', () => ({
  useProfileEngine: () => ({ state: { connected: false, results: {} }, command: vi.fn() }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// No surface requests run in this confirmation fixture.
const host = {} as SurfaceHost;
let root: Root | undefined;
let container: HTMLDivElement | undefined;
let result: Promise<boolean> | undefined;

function Probe({ options }: { options: ConfirmOptions }) {
  const confirm = useSurfaceConfirm();
  return createElement(
    SurfaceFrame,
    { host, confirm, children: null },
    createElement('button', {
      type: 'button',
      id: 'open-confirm',
      onClick: () => {
        result = confirm.confirm(options);
      },
      children: 'Open',
    }),
  );
}
async function open(options: ConfirmOptions) {
  container = document.createElement('div');
  document.body.append(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(createElement(Probe, { options }));
  });
  await act(async () => container!.querySelector<HTMLButtonElement>('#open-confirm')!.click());
}
const labels = () =>
  [...document.querySelectorAll('[role="dialog"] button')].map((button) => button.textContent);

describe('shared surface confirmation language', () => {
  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    result = undefined;
    await surfaceI18n.changeLanguage('en');
  });

  it('translates both defaults and follows a language change while open', async () => {
    await surfaceI18n.changeLanguage('en');
    await open({ title: 'Test confirmation', message: 'Test-owned prompt' });
    expect(labels()).toEqual(['Cancel', 'Confirm', 'Close']);
    await act(async () => {
      await surfaceI18n.changeLanguage('tr');
    });
    expect(labels()).toEqual(['İptal', 'Onayla', 'Kapat']);
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (button) => button.textContent === 'İptal',
    )!;
    await act(async () => cancel.click());
    await expect(result).resolves.toBe(false);
  });

  it('preserves explicit caller labels and still confirms the action', async () => {
    await surfaceI18n.changeLanguage('tr');
    await open({
      title: 'Test confirmation',
      message: 'Test-owned prompt',
      confirmLabel: 'Özel onay',
      cancelLabel: 'Özel iptal',
    });
    expect(labels()).toEqual(['Özel iptal', 'Özel onay', 'Kapat']);
    await act(async () => {
      document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')[1]!.click();
    });
    await expect(result).resolves.toBe(true);
  });
});
