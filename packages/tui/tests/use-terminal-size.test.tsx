import { EventEmitter } from 'node:events';
import { render as renderInk, Text } from 'ink';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { useTerminalSize } from '../src/hooks/use-terminal-size.js';

/**
 * Eleven components each hand-rolled this:
 *
 * ```ts
 * const { stdout } = useStdout();
 * const [w, setW] = useState(stdout?.columns ?? 90);
 * useEffect(() => {
 *   const handleResize = () => setW(stdout?.columns ?? 90);
 *   process.stdout.on('resize', handleResize);   // <-- different stream
 *   return () => process.stdout.off('resize', handleResize);
 * }, [stdout]);
 * ```
 *
 * They subscribed to `process.stdout` and measured Ink's stream. Identical in
 * a real terminal, different objects under a test renderer — and a test in
 * `history-native-scroll.test.tsx` was passing precisely because of the split:
 * it set the width on one stream and fired the event on the other.
 *
 * Nine of the eleven now share this hook. The two that do not are documented
 * where they live: `use-history-viewport-sync` needs `prependListener`
 * ordering, and `use-terminal-render-lifecycle` reads no size at all.
 */

class FakeStdout extends EventEmitter {
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

class FakeStdin extends EventEmitter {
  isTTY = false;
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
}

function mount(tree: ReactElement) {
  const stdout = new FakeStdout();
  const instance = renderInk(tree, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new FakeStdout() as unknown as NodeJS.WriteStream,
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    debug: false,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return { instance, stdout };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('useTerminalSize', () => {
  it('reports the stream it is given', async () => {
    let seen: { columns: number; rows: number } | undefined;
    function Probe(): ReactElement {
      seen = useTerminalSize();
      return <Text>x</Text>;
    }
    const { instance } = mount(<Probe />);
    await settle();
    expect(seen).toEqual({ columns: 100, rows: 40 });
    instance.unmount();
  });

  it('updates when THAT stream resizes', async () => {
    let seen: { columns: number; rows: number } | undefined;
    function Probe(): ReactElement {
      seen = useTerminalSize();
      return <Text>x</Text>;
    }
    const { instance, stdout } = mount(<Probe />);
    await settle();

    stdout.columns = 72;
    stdout.rows = 20;
    stdout.emit('resize');
    await settle();

    expect(seen).toEqual({ columns: 72, rows: 20 });
    instance.unmount();
  });

  it('ignores a resize on a stream it is not reading', async () => {
    // The exact confusion this hook removes: a listener on `process.stdout`
    // firing for a component measuring Ink's stream.
    let seen: { columns: number; rows: number } | undefined;
    function Probe(): ReactElement {
      seen = useTerminalSize();
      return <Text>x</Text>;
    }
    const { instance, stdout } = mount(<Probe />);
    await settle();

    stdout.columns = 55; // changed, but announced on the WRONG stream
    process.stdout.emit('resize');
    await settle();

    expect(seen?.columns).toBe(100);
    instance.unmount();
  });

  it('applies maxWidth as an upper bound only', async () => {
    let seen: { columns: number; rows: number } | undefined;
    function Probe(): ReactElement {
      seen = useTerminalSize({ maxWidth: 80 });
      return <Text>x</Text>;
    }
    const { instance, stdout } = mount(<Probe />);
    await settle();
    expect(seen?.columns).toBe(80);

    // Narrower than the cap: the real width wins, the cap does not pad.
    stdout.columns = 40;
    stdout.emit('resize');
    await settle();
    expect(seen?.columns).toBe(40);
    instance.unmount();
  });

  it('uses the caller-stated fallback when the stream reports no size', async () => {
    // The copies disagreed here — 90, 80 and 100 all appeared — so the
    // fallback is an explicit argument rather than a remembered constant.
    let seen: { columns: number; rows: number } | undefined;
    function Probe(): ReactElement {
      seen = useTerminalSize({ fallbackColumns: 90, fallbackRows: 32 });
      return <Text>x</Text>;
    }
    const { instance, stdout } = mount(<Probe />);
    (stdout as { columns?: number | undefined }).columns = undefined;
    (stdout as { rows?: number | undefined }).rows = undefined;
    stdout.emit('resize');
    await settle();

    expect(seen).toEqual({ columns: 90, rows: 32 });
    instance.unmount();
  });

  it('detaches its listener on unmount', async () => {
    function Probe(): ReactElement {
      useTerminalSize();
      return <Text>x</Text>;
    }
    const { instance, stdout } = mount(<Probe />);
    await settle();
    const attached = stdout.listenerCount('resize');
    expect(attached).toBeGreaterThan(0);

    instance.unmount();
    await settle();
    // Ink keeps its own listener; ours must be gone.
    expect(stdout.listenerCount('resize')).toBeLessThan(attached);
  });
});
