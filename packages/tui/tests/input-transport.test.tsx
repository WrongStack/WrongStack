import { describe, expect, it, vi } from 'vitest';
import { Input, type KeyEvent } from '../src/components/input.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

describe('Input over a terminal transport', () => {
  it.each([
    ['first\rsecond', 'first\nsecond'],
    ['first\r\nsecond', 'first\nsecond'],
    ['\r', '\n'],
    ['[201~ literal marker', '[201~ literal marker'],
  ])('delivers bracketed paste %j as literal data', async (payload, expected) => {
    const events: Array<{ input: string; key: KeyEvent }> = [];
    const view = renderRealTty(
      <Input value="" cursor={0} onKey={(input, key) => events.push({ input, key })} />,
    );
    try {
      await settle();
      view.stdin.write(`\x1b[200~${payload}\x1b[201~`);
      await settle();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        input: expected,
        key: { paste: true, return: false, ctrl: false },
      });
    } finally {
      view.unmount();
    }
  });
  it('does not lose Enter when a PTY batches it with typed text', async () => {
    const events: Array<{ input: string; key: KeyEvent }> = [];
    const view = renderRealTty(
      <Input value="" cursor={0} onKey={(input, key) => events.push({ input, key })} />,
    );
    try {
      await settle();
      view.stdin.write('typed text\r');
      await settle();
      expect(events.map(({ input, key }) => (key.return ? 'ENTER' : input))).toEqual([
        'typed text',
        'ENTER',
      ]);
    } finally {
      view.unmount();
    }
  });
  it.each(['\x1b[H', '\x1b[F', '\x7f', '\x08', '\x1b[3~', '\x1b[1;5D', '\x1b[13;2u'])(
    'delivers editing key %j exactly once',
    async (sequence) => {
      const events: KeyEvent[] = [];
      const view = renderRealTty(
        <Input value="abc" cursor={3} onKey={(_, key) => events.push(key)} />,
      );
      try {
        await settle();
        view.stdin.write(sequence);
        await settle();
        expect(events).toHaveLength(1);
      } finally {
        view.unmount();
      }
    },
  );

  it.each([['\x1bO', 'Q'], ['\x1b', '[12~'], ['\x1bOQ\x1bOR']])(
    'delivers function keys across chunks %j',
    async (...chunks) => {
      const events: number[] = [];
      const view = renderRealTty(
        <Input
          value=""
          cursor={0}
          onKey={(_, key) => {
            if (key.fn) events.push(key.fn);
          }}
        />,
      );
      try {
        await settle();
        for (const chunk of chunks) view.stdin.write(chunk);
        await settle();
        expect(events).toEqual(chunks.length === 1 ? [2, 3] : [2]);
      } finally {
        view.unmount();
      }
    },
  );

  it('does not dispatch a function key or mouse report from inside a paste', async () => {
    const events: KeyEvent[] = [];
    const view = renderRealTty(<Input value="" cursor={0} onKey={(_, key) => events.push(key)} />);
    try {
      await settle();
      for (const chunk of ['\x1b[200~', '\x1bOQ', '\x1b[<64;10;4M', '\x1b[201~']) {
        view.stdin.write(chunk);
      }
      view.stdin.write('\x1bOR');
      await settle();
      expect(events.filter((key) => key.fn || key.mouse)).toEqual([
        expect.objectContaining({ fn: 3 }),
      ]);
    } finally {
      view.unmount();
    }
  });

  it('keeps ordinary text and arrow input live', async () => {
    const events: Array<{ input: string; key: KeyEvent }> = [];
    const view = renderRealTty(
      <Input value="" cursor={0} onKey={(input, key) => events.push({ input, key })} />,
    );
    try {
      await settle();
      view.stdin.write('hello');
      view.stdin.write('\x1b[D');
      await settle();
      expect(events.map(({ input }) => input)).toEqual(['hello', '']);
      expect(events[1]?.key.leftArrow).toBe(true);
    } finally {
      view.unmount();
    }
  });

  it('preserves the order of typing and function keys batched in one read', async () => {
    const events: string[] = [];
    const view = renderRealTty(
      <Input
        value=""
        cursor={0}
        onKey={(input, key) => events.push(key.fn ? `F${key.fn}` : input)}
      />,
    );
    try {
      await settle();
      view.stdin.write('before\x1bOQafter\x1bOR');
      await settle();
      expect(events).toEqual(['before', 'F2', 'after', 'F3']);
    } finally {
      view.unmount();
    }
  });

  it('keeps F-key and mouse routing alive while disabled and hidden', async () => {
    const events: KeyEvent[] = [];
    const view = renderRealTty(
      <Input value="saved" cursor={5} disabled hidden onKey={(_, key) => events.push(key)} />,
    );
    try {
      await settle();
      for (const chunk of ['x', '\x7f', '\x1bO', 'Q', '\x1b[<', '64;10;4M', '\x03']) {
        view.stdin.write(chunk);
      }
      await settle();
      expect(events).toHaveLength(3);
      expect(events[0]?.fn).toBe(2);
      expect(events[1]?.mouse?.kind).toBe('wheel');
      expect(events[2]?.ctrl).toBe(true);
    } finally {
      view.unmount();
    }
  });

  it('preserves Alt+Backspace as word deletion and ignores key-release reports', async () => {
    const events: KeyEvent[] = [];
    const view = renderRealTty(
      <Input value="alpha beta" cursor={10} onKey={(_, key) => events.push(key)} />,
    );
    try {
      await settle();
      view.stdin.write('\x1b\x7f');
      view.stdin.write('\x1b[127;1:3u');
      await settle();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ backspace: true, ctrl: true });
    } finally {
      view.unmount();
    }
  });

  it.each(['\x1b[5D', '\x1b[5C'])(
    'preserves the legacy Ctrl+Arrow encoding %j',
    async (sequence) => {
      const events: KeyEvent[] = [];
      const view = renderRealTty(
        <Input value="alpha beta" cursor={10} onKey={(_, key) => events.push(key)} />,
      );
      try {
        await settle();
        view.stdin.write(sequence);
        await settle();
        expect(events).toHaveLength(1);
        expect(events[0]?.ctrl).toBe(true);
        expect(sequence.endsWith('D') ? events[0]?.leftArrow : events[0]?.rightArrow).toBe(true);
      } finally {
        view.unmount();
      }
    },
  );

  it('does not join a timed-out Escape to later ordinary typing', async () => {
    const events: Array<{ input: string; key: KeyEvent }> = [];
    const view = renderRealTty(
      <Input value="" cursor={0} onKey={(input, key) => events.push({ input, key })} />,
    );
    try {
      await settle();
      vi.useFakeTimers();
      view.stdin.write('\x1b');
      await vi.advanceTimersByTimeAsync(21);
      view.stdin.write('OQ');
      expect(events).toHaveLength(2);
      expect(events[0]?.key.escape).toBe(true);
      expect(events[1]?.input).toBe('OQ');
      expect(events.some(({ key }) => key.fn)).toBe(false);
    } finally {
      vi.useRealTimers();
      view.unmount();
    }
  });
});
