// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProcessKillAll } from '../src/ProcessKillAll';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
  this.open = false;
};

describe('terminating every process of a conversation', () => {
  let root: Root;
  let host: HTMLElement;
  const press = (text: string) =>
    act(async () =>
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent?.includes(text))
        ?.click(),
    );
  async function render(
    command: ReturnType<typeof vi.fn>,
    onDone: ReturnType<typeof vi.fn>,
    running = 3,
  ) {
    await act(async () =>
      root.render(
        createElement(ProcessKillAll, {
          sessionId: 's-1',
          running,
          connected: true,
          busy: false,
          command: command as never,
          onDone: onDone as never,
        }),
      ),
    );
  }
  beforeEach(async () => {
    await surfaceI18n.changeLanguage('en');
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('asks first, then sends one session-scoped kill-all request', async () => {
    const command = vi.fn(async () => ({
      success: true,
      message: 'Killed processes for session s-1',
    }));
    const onDone = vi.fn();
    await render(command, onDone);
    await press('Terminate all…');
    // Nothing is sent before the confirmation, which names how many are running.
    expect(command).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Terminate all 3 running processes?');
    await press('Keep processes running');
    expect(document.body.textContent).not.toContain('Terminate all 3 running processes?');
    expect(command).not.toHaveBeenCalled();
    await press('Terminate all…');
    const confirm = [...document.querySelectorAll('dialog button')].find(
      (button) => button.textContent === 'Terminate all',
    ) as HTMLButtonElement;
    await act(async () => confirm.click());
    expect(command).toHaveBeenCalledWith('process.killAll', { sessionId: 's-1' }, [
      'key.operation_result',
    ]);
    expect(onDone).toHaveBeenCalledWith({
      ok: true,
      message: 'Killed processes for session s-1 Refresh verifies whether any is still tracked.',
    });
    act(() => root.unmount());
  });

  it('reports a refused request and is not offered while nothing runs', async () => {
    const command = vi.fn(async () => {
      throw new Error('Process termination denied: policy');
    });
    const onDone = vi.fn();
    await render(command, onDone, 1);
    await press('Terminate all…');
    expect(document.body.textContent).toContain('Terminate the 1 running process?');
    const confirm = [...document.querySelectorAll('dialog button')].find(
      (button) => button.textContent === 'Terminate all',
    ) as HTMLButtonElement;
    await act(async () => confirm.click());
    expect(onDone).toHaveBeenCalledWith({
      ok: false,
      message: 'Process termination denied: policy',
    });
    act(() => root.unmount());
    root = createRoot(host);
    await render(vi.fn(), vi.fn(), 0);
    expect(host.textContent).toBe('');
    act(() => root.unmount());
  });

  it('speaks Turkish', async () => {
    await surfaceI18n.changeLanguage('tr');
    await render(vi.fn(), vi.fn(), 2);
    await press('Tümünü sonlandır…');
    expect(document.body.textContent).toContain('Çalışan 2 sürecin tümü sonlandırılsın mı?');
    act(() => root.unmount());
  });
});
