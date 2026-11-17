import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  send: vi.fn(),
  font: { fontFamily: 'monospace', fontSize: 14, lineHeight: 1 },
  nextSize: { cols: 80, rows: 24 },
  terminal: null as null | { resize(cols: number, rows: number): void },
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
    options = {};
    resizeListener?: (size: { cols: number; rows: number }) => void;
    constructor() {
      fixture.terminal = this;
    }
    loadAddon() {}
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

import { TerminalPanel } from '@/components/TerminalPanel';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
