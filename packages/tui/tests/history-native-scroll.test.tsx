import { EventEmitter } from 'node:events';
import { render as renderInk } from 'ink';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { History, type HistoryEntry } from '../src/components/history.js';

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function view(entries: HistoryEntry[], generation = 0) {
  return <History entries={entries} generation={generation} toolStream={null} />;
}

class TestOutput extends EventEmitter {
  columns = 100;
  rows = 40;
  isTTY = true;
  frames: string[] = [];
  write = (data: string | Uint8Array): boolean => {
    this.frames.push(String(data));
    return true;
  };
  getColorDepth = () => 8;
}

class TestInput extends EventEmitter {
  isTTY = false;
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
}

function render(tree: ReactElement) {
  const stdout = new TestOutput();
  const stderr = new TestOutput();
  const stdin = new TestInput();
  const instance = renderInk(tree, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: false,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return { ...instance, frames: stdout.frames, stdout };
}

describe('<History /> native scrollback commits', () => {
  it('emits each committed entry once across unrelated rerenders', () => {
    const entries: HistoryEntry[] = [{ id: 1, kind: 'info', text: 'native-entry-one' }];
    const screen = render(view(entries));

    screen.rerender(view(entries));
    screen.rerender(view(entries));

    expect(count(screen.frames.join('\n'), 'native-entry-one')).toBe(1);
    screen.unmount();
  });

  it('emits only each render delta across consecutive entry updates', () => {
    const screen = render(view([{ id: 1, kind: 'info', text: 'delta-entry-one' }]));

    screen.rerender(
      view([
        { id: 1, kind: 'info', text: 'delta-entry-one' },
        { id: 2, kind: 'info', text: 'delta-entry-two' },
      ]),
    );
    screen.rerender(
      view([
        { id: 1, kind: 'info', text: 'delta-entry-one' },
        { id: 2, kind: 'info', text: 'delta-entry-two' },
        { id: 3, kind: 'info', text: 'delta-entry-three' },
      ]),
    );

    const output = screen.frames.join('\n');
    expect(count(output, 'delta-entry-one')).toBe(1);
    expect(count(output, 'delta-entry-two')).toBe(1);
    expect(count(output, 'delta-entry-three')).toBe(1);
    screen.unmount();
  });

  it('continues emitting when reducer retention shifts the prefix at a flat length', () => {
    const first: HistoryEntry[] = [
      {
        id: -2,
        kind: 'info',
        text: '… 1 earlier TUI entries omitted (full session remains on disk).',
      },
      { id: 10, kind: 'info', text: 'retained-ten' },
      { id: 11, kind: 'info', text: 'retained-eleven' },
    ];
    const screen = render(view(first));
    const shifted: HistoryEntry[] = [
      {
        id: -3,
        kind: 'info',
        text: '… 2 earlier TUI entries omitted (full session remains on disk).',
      },
      { id: 11, kind: 'info', text: 'retained-eleven' },
      { id: 12, kind: 'info', text: 'native-entry-twelve' },
    ];

    screen.rerender(view(shifted));

    const output = screen.frames.join('\n');
    expect(count(output, 'native-entry-twelve')).toBe(1);
    expect(count(output, 'retained-eleven')).toBe(1);
    expect(output).not.toContain('… 2 earlier TUI entries omitted');
    screen.unmount();
  });

  it('does not treat unrelated negative ids as retention omission markers', () => {
    const screen = render(
      view([
        { id: -20, kind: 'info', text: 'negative-entry-one' },
        { id: -19, kind: 'info', text: 'negative-entry-two' },
      ]),
    );

    const output = screen.frames.join('\n');
    expect(count(output, 'negative-entry-one')).toBe(1);
    expect(count(output, 'negative-entry-two')).toBe(1);
    screen.unmount();
  });

  it('restarts emission after an explicit history generation reset', () => {
    const screen = render(view([{ id: 1, kind: 'info', text: 'before-clear' }], 0));

    screen.rerender(view([{ id: 0, kind: 'info', text: 'after-clear' }], 1));

    const output = screen.frames.join('\n');
    expect(count(output, 'before-clear')).toBe(1);
    expect(count(output, 'after-clear')).toBe(1);
    screen.unmount();
  });

  it('does not re-emit committed history across many entry-appending rerenders', () => {
    const baseEntries: HistoryEntry[] = Array.from({ length: 400 }, (_, index) => ({
      id: index + 1,
      kind: 'info',
      text: `committed-history-${index + 1}`,
    }));
    const screen = render(view(baseEntries));
    const initialOutput = screen.frames.join('\n');
    expect(initialOutput).toContain('committed-history-1');
    expect(initialOutput).toContain('committed-history-400');
    screen.frames.length = 0;

    // Append one new entry per rerender so the entries prop reference changes
    // each iteration — History is React.memo-wrapped with shallow comparison,
    // so mutating the same array with .push() would short-circuit and never
    // reach the emission-dedup logic.
    let currentEntries = baseEntries;
    for (let index = 0; index < 250; index += 1) {
      const newId = baseEntries.length + index + 1;
      currentEntries = [
        ...currentEntries,
        { id: newId, kind: 'info', text: `appended-entry-${newId}` },
      ];
      screen.rerender(<History entries={currentEntries} generation={0} toolStream={null} />);
    }

    const output = screen.frames.join('\n');
    // Original committed entries (ids 1–400) must not be re-emitted
    expect(output).not.toContain('committed-history-1');
    expect(output).not.toContain('committed-history-400');
    // Each appended entry should appear exactly once
    expect(count(output, 'appended-entry-')).toBe(250);
    screen.unmount();
  });

  it('replays committed history when terminal width changes', { timeout: 5000 }, async () => {
    const screen = render(view([{ id: 1, kind: 'info', text: 'native-resize-history-marker' }]));
    screen.frames.length = 0;
    screen.stdout.columns = 72;

    // Emit on the stream the component READS. This used to emit on
    // `process.stdout` while setting the width on Ink's stream — which worked
    // only because <History /> subscribed to one and measured the other. That
    // split is the bug `useTerminalSize` exists to close (see
    // `hooks/use-terminal-size.ts`), and a real resize fires on the stream Ink
    // holds. `helpers/real-tty.tsx` already does it this way.
    screen.stdout.emit('resize');
    await new Promise((resolve) => setImmediate(resolve));

    expect(count(screen.frames.join('\n'), 'native-resize-history-marker')).toBe(1);
    screen.unmount();
  });
});
