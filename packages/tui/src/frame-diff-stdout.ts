/**
 * Line-level frame diffing below Ink.
 *
 * On Windows consoles Ink repaints every frame that fills the viewport in
 * full: cursor home, erase to end of screen, then the whole frame, and it
 * does so even when the frame is identical to the last one (its "skip an
 * unchanged frame" check is bypassed on that path, and `incrementalRendering`
 * with it). The TUI always fills the viewport, so every render there cost a
 * whole-screen erase and rewrite. Where the terminal honours synchronized
 * output that is invisible; where it does not (classic conhost, tmux without
 * passthrough) the erase is the flicker.
 *
 * This wrapper recognises those full frames by Ink's own prefix and, when the
 * previous frame is known, writes only the rows that changed, each addressed
 * absolutely. Nothing is erased that is not immediately rewritten, and an
 * unchanged frame writes nothing at all.
 *
 * It stays honest about what it does not know: any other write that could
 * touch the grid, a resize, or an explicit `invalidate()` drops the remembered
 * frame, and the next frame goes through whole exactly as Ink wrote it. A
 * whole frame is also let through at least once per `fullRepaintMs`, so a
 * screen disturbed by something this wrapper never saw heals itself.
 */

/** `ansiEscapes.cursorTo(0, 0) + ansiEscapes.eraseDown`: Ink's full-frame prefix. */
export const INK_FULL_FRAME_PREFIX = '\x1b[1;1H\x1b[J';

/** Longest a diffed screen goes without one whole-frame repaint. */
export const DEFAULT_FULL_REPAINT_MS = 1000;

export interface FrameDiffStdoutOptions {
  /** Default true. False returns the target stream untouched. */
  enabled?: boolean | undefined;
  fullRepaintMs?: number | undefined;
  /** Clock override for tests. */
  now?: (() => number) | undefined;
}

export interface FrameDiffStdoutHandle {
  /** Stream to hand to Ink's `render({ stdout })`. */
  stream: NodeJS.WriteStream;
  /** Forget the remembered frame: the next frame is written whole. */
  invalidate: () => void;
}

type WriteCallback = ((err?: Error | null) => void) | undefined;

/**
 * Writes that cannot change what is on the grid: private mode sets and resets
 * (synchronized output, cursor visibility, mouse and paste modes), OSC strings
 * (title, clipboard) and the bell.
 */
const GRID_NEUTRAL_RE = /^(?:\x1b\[\?[0-9;]*[hl]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x07)*$/;

interface RememberedFrame {
  lines: string[];
  rows: number;
  columns: number;
}

export function createFrameDiffStdout(
  target: NodeJS.WriteStream,
  opts: FrameDiffStdoutOptions = {},
): FrameDiffStdoutHandle {
  if (opts.enabled === false) return { stream: target, invalidate: () => {} };

  const fullRepaintMs = opts.fullRepaintMs ?? DEFAULT_FULL_REPAINT_MS;
  const now = opts.now ?? Date.now;
  let remembered: RememberedFrame | null = null;
  let lastFullAt = 0;

  const passThrough = (
    chunk: Uint8Array | string,
    encoding: BufferEncoding | undefined,
    callback: WriteCallback,
  ): boolean => {
    if (callback) return target.write(chunk as never, encoding as never, callback as never);
    return encoding ? target.write(chunk as never, encoding) : target.write(chunk as never);
  };

  const write = (
    chunk: Uint8Array | string,
    encodingOrCb?: BufferEncoding | WriteCallback,
    cb?: WriteCallback,
  ): boolean => {
    const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');

    if (!text.startsWith(INK_FULL_FRAME_PREFIX)) {
      // Anything that might draw or erase makes the remembered frame a guess.
      if (!GRID_NEUTRAL_RE.test(text)) remembered = null;
      return passThrough(chunk, encoding, callback);
    }

    const rows = target.rows;
    const columns = target.columns;
    const lines = text.slice(INK_FULL_FRAME_PREFIX.length).split('\n');
    // Only a frame of exactly one line per row can be addressed row by row; a
    // taller one scrolls the terminal and must be written as Ink wrote it.
    const addressable = typeof rows === 'number' && lines.length === rows;
    const previous = remembered;
    const at = now();

    if (
      !addressable ||
      previous === null ||
      previous.rows !== rows ||
      previous.columns !== columns ||
      previous.lines.length !== lines.length ||
      at - lastFullAt >= fullRepaintMs
    ) {
      remembered = addressable ? { lines, rows, columns } : null;
      lastFullAt = at;
      return passThrough(chunk, encoding, callback);
    }

    let out = '';
    for (let row = 0; row < lines.length; row++) {
      const line = lines[row] as string;
      if (line === previous.lines[row]) continue;
      // Absolute row, clear it, write it. Clearing first needs no width
      // arithmetic, so a wide glyph or an ambiguous-width character cannot
      // leave a stale cell or eat the last column.
      out += `\x1b[${row + 1};1H\x1b[2K${line}`;
    }
    remembered = { lines, rows, columns };
    if (out === '') {
      callback?.(null);
      return true;
    }
    return callback ? target.write(out, callback as never) : target.write(out);
  };

  const stream = new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === 'write') return write;
      const value: unknown = Reflect.get(obj, prop, receiver);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(obj)
        : value;
    },
  });

  return {
    stream,
    invalidate: () => {
      remembered = null;
    },
  };
}

/** Whether the frame differ is on. `WRONGSTACK_TUI_FRAME_DIFF=0` turns it off. */
export function tuiFrameDiffEnabled(): boolean {
  return process.env['WRONGSTACK_TUI_FRAME_DIFF'] !== '0';
}
