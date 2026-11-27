import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  send: vi.fn(),
  font: { fontFamily: 'monospace', fontSize: 14, lineHeight: 1 },
  nextSize: { cols: 80, rows: 24 },
  terminal: null as null | {
    resize(cols: number, rows: number): void;
    unicode: { activeVersion: string };
    addons: unknown[];
    options: Record<string, unknown>;
  },
}));
vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({ send: fixture.send, on: () => () => {} }),
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
    write() {}
    dispose() {}
    onData() {
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
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

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
  expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal.create' }));
  fixture.send.mockClear();
  fixture.nextSize = { cols: 62, rows: 18 };
  fixture.font = { ...fixture.font, fontSize: 20 };
  view.rerender(<TerminalPanel onClose={() => {}} onDispose={() => {}} />);
  expect(fixture.send).toHaveBeenCalledWith({
    type: 'terminal.resize',
    payload: { id: expect.any(String), cols: 62, rows: 18 },
  });
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
