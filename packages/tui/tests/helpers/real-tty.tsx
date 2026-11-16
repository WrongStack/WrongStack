/**
 * Real-layout render harness for viewport tests.
 *
 * `ink-testing-library` renders through a stream that Ink does not treat as a
 * TTY, and `measureElement` reads 0 for every node there — which silently
 * skips the ScrollableHistory measurement path and lets estimate-vs-actual
 * bugs through the suite unseen. This harness drives Ink's own `render()`
 * against a fake TTY stdout (columns/rows/isTTY) in debug mode, so yoga runs
 * a real layout, `measureElement` returns real heights, and every captured
 * frame is exactly what a terminal of that size would show.
 */
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import type { ReactElement } from 'react';

class FakeStdout extends EventEmitter {
  isTTY = true;
  frames: string[] = [];
  constructor(
    public columns: number,
    public rows: number,
  ) {
    super();
  }
  write(chunk: string): boolean {
    this.frames.push(chunk);
    return true;
  }
}

class FakeStdin extends EventEmitter {
  private chunks: string[] = [];
  isTTY = true;
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  read(): string | null {
    return this.chunks.shift() ?? null;
  }
  ref(): void {}
  unref(): void {}
  write(input: string): void {
    this.chunks.push(input);
    this.emit('data', Buffer.from(input));
    this.emit('readable');
  }
}

/** Let Ink flush renders, layout effects, and follow-up commits. */
export const settle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Strip ANSI colors/links so assertions read plain text. */
export const cleanFrame = (frame: string): string =>
  // eslint-disable-next-line no-control-regex
  frame.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\]8;[^\x07]*?(?:\x07|\x1b\\)/g, '');

export interface RealTtyView {
  /** Latest full frame (ANSI stripped). */
  lastFrame(): string;
  /** Latest frame split into lines (ANSI stripped). */
  lines(): string[];
  rerender(element: ReactElement): void;
  /** Change the fake terminal size and emit 'resize' like a real TTY. */
  resize(columns: number, rows: number): void;
  unmount(): void;
  stdout: FakeStdout;
  stdin: FakeStdin;
}

/** Render into a fake TTY of the given size with Ink's real renderer. */
export function renderRealTty(
  element: ReactElement,
  {
    columns = 60,
    rows = 30,
    debug = true,
  }: { columns?: number; rows?: number; debug?: boolean } = {},
): RealTtyView {
  const stdout = new FakeStdout(columns, rows);
  const stdin = new FakeStdin();
  const instance = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    lastFrame: () => cleanFrame(stdout.frames.at(-1) ?? ''),
    lines: () => cleanFrame(stdout.frames.at(-1) ?? '').split('\n'),
    rerender: (next) => instance.rerender(next),
    resize: (columns, rows) => {
      stdout.columns = columns;
      stdout.rows = rows;
      stdout.emit('resize');
    },
    unmount: () => instance.unmount(),
    stdout,
    stdin,
  };
}
