// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptRefinement } from '../src/PromptRefinement';
import { readRefineCountdownMs, writeRefineCountdownMs } from '../src/refine-countdown';
import { enhanceDelayField, refineCountdownField } from '../src/refinement-policy-model';
import { SettingRow } from '../src/SettingRow';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
  this.open = false;
};

describe('the refine countdown setting', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to three seconds and keeps whole seconds within 0–10', () => {
    expect(readRefineCountdownMs()).toBe(3000);
    expect(writeRefineCountdownMs(2400)).toBe(2000);
    expect(writeRefineCountdownMs(60_000)).toBe(10_000);
    expect(writeRefineCountdownMs(-1)).toBe(3000);
    expect(writeRefineCountdownMs(undefined)).toBe(3000);
    localStorage.setItem('wrongstack.desktop.refine-countdown-ms', 'abc');
    expect(readRefineCountdownMs()).toBe(3000);
    expect(writeRefineCountdownMs(0)).toBe(0);
    expect(localStorage.getItem('wrongstack.desktop.refine-countdown-ms')).toBe('0');
    expect(readRefineCountdownMs()).toBe(0);
  });
});

describe('refinement opened on submit', () => {
  let root: Root;
  let host: HTMLElement;
  const reply = { refined: 'Fix the login bug', english: 'Fix the login bug' };
  async function open(countdown: boolean, onSend = vi.fn(async () => undefined)) {
    const command = vi.fn(async () => reply);
    await act(async () =>
      root.render(
        createElement(PromptRefinement, {
          original: 'fix login',
          mode: 'queue',
          command: command as never,
          state: { results: {}, provider: 'p', model: 'm', hydrating: false } as never,
          onClose: () => undefined,
          onApply: () => undefined,
          onSend,
          countdown,
        }),
      ),
    );
    return { command, onSend };
  }
  const press = (text: string) =>
    act(async () =>
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent?.includes(text))
        ?.click(),
    );
  beforeEach(async () => {
    await surfaceI18n.changeLanguage('en');
    localStorage.clear();
    vi.useFakeTimers();
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('waits the countdown before asking the refiner', async () => {
    writeRefineCountdownMs(2000);
    const { command } = await open(true);
    expect(document.body.textContent).toContain('Refining in 2 seconds…');
    expect(command).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(document.body.textContent).toContain('Refining in 1 second…');
    expect(command).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(command).toHaveBeenCalledTimes(1);
    expect(command.mock.calls[0]?.[0]).toBe('model.refine');
  });

  it('sends the prompt as written from the countdown without refining', async () => {
    const { command, onSend } = await open(true);
    await press('Send as written');
    expect(onSend).toHaveBeenCalledWith('fix login', 'queue');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(command).not.toHaveBeenCalled();
  });

  it('refines at once on request, with a zero countdown, and for an explicit refine', async () => {
    const first = await open(true);
    await press('Refine now');
    expect(first.command).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    root = createRoot(host);
    writeRefineCountdownMs(0);
    const zero = await open(true);
    expect(zero.command).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    root = createRoot(host);
    writeRefineCountdownMs(5000);
    const explicit = await open(false);
    expect(explicit.command).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain('Refining in');
  });
});

describe('the refinement timing settings', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('shows the delay and countdown in seconds, in the display language', async () => {
    await surfaceI18n.changeLanguage('en');
    const host = document.createElement('div');
    const root = createRoot(host);
    const onChange = vi.fn();
    const render = () =>
      act(async () =>
        root.render(
          createElement('div', null, [
            createElement(SettingRow, {
              key: 'd',
              field: enhanceDelayField,
              value: 15000,
              onChange,
            }),
            createElement(SettingRow, {
              key: 'c',
              field: refineCountdownField,
              value: 3000,
              onChange: vi.fn(),
            }),
          ]),
        ),
      );
    await render();
    expect(host.textContent).toContain('Refine delay');
    expect(host.textContent).toContain('Refine countdown');
    const delay = host.querySelector<HTMLInputElement>('#setting-enhanceDelayMs')!;
    expect(delay.value).toBe('15');
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(delay, '30');
      delay.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(30000);
    await act(async () => {
      await surfaceI18n.changeLanguage('tr');
    });
    await render();
    expect(host.textContent).toContain('İyileştirme gecikmesi');
    expect(host.textContent).toContain('İyileştirme geri sayımı');
    act(() => root.unmount());
  });
});
