import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WSServerMessage } from '@/types';

const fixture = vi.hoisted(() => ({
  send: vi.fn(),
  writes: vi.fn(),
  handlers: new Map<string, (message: WSServerMessage) => void>(),
  status: null as null | ((status: { state: string }) => void),
  font: { fontFamily: 'monospace', fontSize: 14, lineHeight: 1 },
  nextSize: { cols: 80, rows: 24 },
  terminal: null as null | {
    resize(cols: number, rows: number): void;
    unicode: { activeVersion: string };
    addons: unknown[];
    options: Record<string, unknown>;
    input?: (data: string) => void;
  },
}));
vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({
    send: fixture.send,
    on: (name: string, handler: (message: WSServerMessage) => void) => {
      fixture.handlers.set(name, handler);
      return () => fixture.handlers.delete(name);
    },
    onStatus: (handler: (status: { state: string }) => void) => {
      fixture.status = handler;
      handler({ state: 'open' });
      return () => {
        fixture.status = null;
      };
    },
  }),
}));
vi.mock('@/hooks/use-font-settings', () => ({
  useFontSettings: () => ({ terminal: fixture.font }),
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    unicode = { activeVersion: '6' };
    addons: unknown[] = [];
    options: Record<string, unknown>;
    resizeListener?: (size: { cols: number; rows: number }) => void;
    constructor(options: Record<string, unknown> = {}) {
      this.options = options;
      fixture.terminal = this;
    }
    loadAddon(addon: unknown) {
      this.addons.push(addon);
    }
    open() {}
    focus() {}
    write(data: string) {
      fixture.writes(data);
    }
    dispose() {}
    input?: (data: string) => void;
    onData(input: (data: string) => void) {
      this.input = input;
      return { dispose() {} };
    }
    onResize(listener: (size: { cols: number; rows: number }) => void) {
      this.resizeListener = listener;
      return {
        dispose: () => {
          this.resizeListener = undefined;
        },
      };
    }
    resize(cols: number, rows: number) {
      if (this.cols === cols && this.rows === rows) return;
      this.cols = cols;
      this.rows = rows;
      this.resizeListener?.({ cols, rows });
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {
      fixture.terminal?.resize(fixture.nextSize.cols, fixture.nextSize.rows);
    }
  },
}));

vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: class Unicode11Addon {},
}));

import { Unicode11Addon } from '@xterm/addon-unicode11';
import { TerminalPanel } from '@/components/TerminalPanel';
import { i18n } from '@/i18n';
import { TERMINAL_HEIGHT_STORAGE_KEY } from '@/lib/terminal-dock';

afterEach(() => {
  cleanup();
  fixture.send.mockClear();
  fixture.writes.mockClear();
  fixture.nextSize = { cols: 80, rows: 24 };
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function ready(): string {
  const id = fixture.send.mock.calls.find(([message]) => message.type === 'terminal.create')?.[0]
    .payload.id;
  act(() =>
    fixture.handlers.get('terminal.ready')?.({
      type: 'terminal.ready',
      payload: { id, resumed: false },
    }),
  );
  return id;
}

it('sends a font-driven grid change to the PTY without a container resize', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  const view = render(<TerminalPanel onClose={() => {}} onDispose={() => {}} />);
  expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal.create' }), {
    queueIfDisconnected: false,
  });
  ready();
  fixture.send.mockClear();
  fixture.nextSize = { cols: 62, rows: 18 };
  fixture.font = { ...fixture.font, fontSize: 20 };
  view.rerender(<TerminalPanel onClose={() => {}} onDispose={() => {}} />);
  expect(fixture.send).toHaveBeenCalledWith(
    {
      type: 'terminal.resize',
      payload: { id: expect.any(String), cols: 62, rows: 18 },
    },
    { queueIfDisconnected: false },
  );
});

it('keeps the emulator, skips duplicate output and does not replay offline keystrokes', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  render(<TerminalPanel onClose={() => {}} onDispose={() => {}} />);
  const terminal = fixture.terminal!;
  const id = ready();
  const output = (sequence: number, data: string) =>
    act(() =>
      fixture.handlers.get('terminal.output')?.({
        type: 'terminal.output',
        payload: { id, sequence, data },
      }),
    );
  output(1, 'seen');
  act(() => fixture.status?.({ state: 'closed' }));
  terminal.input?.('offline');
  act(() => fixture.status?.({ state: 'open' }));
  expect(terminal).toBe(fixture.terminal);
  expect(
    fixture.send.mock.calls
      .filter(([msg]) => msg.type === 'terminal.create')
      .map(([msg]) => msg.payload),
  ).toEqual([
    expect.objectContaining({ id, after: 0, resumeOnly: false }),
    expect.objectContaining({ id, after: 1, resumeOnly: true }),
  ]);
  ready();
  output(1, 'seen');
  output(2, 'missed');
  terminal.input?.('online');
  expect(fixture.writes.mock.calls).toEqual([['seen'], ['missed']]);
  expect(fixture.send.mock.calls.filter(([msg]) => msg.type === 'terminal.input')).toEqual([
    [{ type: 'terminal.input', payload: { id, data: 'online' } }, { queueIfDisconnected: false }],
  ]);
});

it('measures with Unicode 11 widths, as the TUI and the PTY host do', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  render(<TerminalPanel onClose={() => {}} onDispose={() => {}} />);
  const terminal = fixture.terminal!;
  expect(terminal.options.allowProposedApi).toBe(true);
  expect(terminal.addons.some((addon) => addon instanceof Unicode11Addon)).toBe(true);
  expect(terminal.unicode.activeVersion).toBe('11');
});

it('resizes the terminal dock from the keyboard and exposes separator state', async () => {
  await i18n.changeLanguage('en');
  vi.stubGlobal('innerHeight', 900);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  window.localStorage.setItem(TERMINAL_HEIGHT_STORAGE_KEY, '300');

  render(<TerminalPanel onClose={() => {}} onDispose={() => {}} />);
  const dock = document.querySelector<HTMLElement>('[data-terminal-dock]');
  const handle = screen.getByTitle('Resize terminals');

  // Control: the real dock renders a focusable separator at the stored height.
  expect(handle.getAttribute('tabindex')).toBe('0');
  expect(dock?.style.height).toBe('300px');
  expect(handle.getAttribute('aria-valuemin')).toBe('140');
  expect(handle.getAttribute('aria-valuemax')).toBe('495');
  expect(handle.getAttribute('aria-valuenow')).toBe('300');

  fireEvent.keyDown(handle, { key: 'ArrowUp' });
  expect(dock?.style.height).toBe('316px');
  expect(handle.getAttribute('aria-valuenow')).toBe('316');

  fireEvent.keyDown(handle, { key: 'ArrowDown' });
  expect(dock?.style.height).toBe('300px');

  fireEvent.keyDown(handle, { key: 'Home' });
  expect(dock?.style.height).toBe('140px');

  fireEvent.keyDown(handle, { key: 'End' });
  expect(dock?.style.height).toBe('495px');
  expect(handle.getAttribute('aria-valuenow')).toBe('495');
});
