/**
 * A small VT screen model: enough of a terminal to say what a byte stream
 * leaves on the grid.
 *
 * It understands what the TUI's renderer writes and what Windows ConPTY writes
 * back when it re-renders its own screen buffer: cursor addressing and
 * relative moves, the line and screen erases, erase-characters, SGR attributes
 * (so an erase with a stray background shows up), CR/LF/BS, and it skips
 * private modes and OSC strings, which do not touch the grid. Anything else
 * throws, so a sequence the model does not cover fails the test instead of
 * being silently ignored.
 *
 * Every glyph is treated as one column wide: feed it width-1 content.
 */
const ESC = '\x1b';

interface Sgr {
  fg: string;
  bg: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  strike: boolean;
}

const PLAIN: Sgr = {
  fg: '',
  bg: '',
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  strike: false,
};

const sgrKey = (s: Sgr): string =>
  `${s.fg}|${s.bg}|${Number(s.bold)}${Number(s.dim)}${Number(s.italic)}${Number(s.underline)}${Number(s.inverse)}${Number(s.strike)}`;

function applySgr(state: Sgr, params: number[]): Sgr {
  let next = { ...state };
  const codes = params.length === 0 ? [0] : params;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i] as number;
    if (code === 0) next = { ...PLAIN };
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 3) next.italic = true;
    else if (code === 23) next.italic = false;
    else if (code === 4) next.underline = true;
    else if (code === 24) next.underline = false;
    else if (code === 7) next.inverse = true;
    else if (code === 27) next.inverse = false;
    else if (code === 9) next.strike = true;
    else if (code === 29) next.strike = false;
    else if (code === 39) next.fg = '';
    else if (code === 49) next.bg = '';
    else if (code === 38 || code === 48) {
      const mode = codes[i + 1];
      const span = mode === 2 ? 5 : mode === 5 ? 3 : 1;
      // Normalised, so `38;2;r;g;b` and a terminal's re-encoding compare equal.
      const value = codes.slice(i + 1, i + span).join(';');
      if (code === 38) next.fg = value;
      else next.bg = value;
      i += span - 1;
    } else if (code >= 30 && code <= 37) next.fg = `5;${code - 30}`;
    else if (code >= 90 && code <= 97) next.fg = `5;${code - 90 + 8}`;
    else if (code >= 40 && code <= 47) next.bg = `5;${code - 40}`;
    else if (code >= 100 && code <= 107) next.bg = `5;${code - 100 + 8}`;
  }
  return next;
}

export class VtScreen {
  private cells: string[][];
  private row = 0;
  private col = 0;
  private sgr: Sgr = { ...PLAIN };

  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    this.cells = Array.from({ length: rows }, () => this.blankRow());
  }

  /**
   * One cell: attributes, a separator, the glyph. A space only shows its
   * background (or, inverted, its foreground), underline and strike-through,
   * so an erased cell and a space written in default attributes are the same
   * cell: a terminal repainting its buffer is free to use either.
   */
  private cell(glyph: string): string {
    if (glyph !== ' ') return `${sgrKey(this.sgr)}\u0000${glyph}`;
    const { sgr } = this;
    const visible: Sgr = {
      ...PLAIN,
      bg: sgr.bg,
      fg: sgr.inverse ? sgr.fg : '',
      inverse: sgr.inverse,
      underline: sgr.underline,
      strike: sgr.strike,
    };
    return `${sgrKey(visible)}\u0000 `;
  }

  /** What an erase leaves: a space in the current background only. */
  private blank(): string {
    return `${sgrKey({ ...PLAIN, bg: this.sgr.bg })}\u0000 `;
  }

  private blankRow(): string[] {
    return Array.from({ length: this.columns }, () => this.blank());
  }

  feed(data: string): void {
    let i = 0;
    while (i < data.length) {
      const ch = data[i] as string;
      if (ch === ESC && data[i + 1] === '[') {
        const match = /^\x1b\[([?>0-9;]*)([A-Za-z@])/.exec(data.slice(i, i + 64));
        if (!match) throw new Error(`unparsed CSI: ${JSON.stringify(data.slice(i, i + 16))}`);
        this.csi(match[1] as string, match[2] as string);
        i += match[0].length;
        continue;
      }
      if (ch === ESC && data[i + 1] === ']') {
        const rest = data.slice(i);
        const end = rest.search(/\x07|\x1b\\/);
        if (end < 0) throw new Error('unterminated OSC');
        i += end + (rest[end] === ESC ? 2 : 1);
        continue;
      }
      if (ch === ESC)
        throw new Error(`unsupported escape: ${JSON.stringify(data.slice(i, i + 8))}`);
      if (ch === '\n') {
        // Terminals in their default output mode return the carriage on a line
        // feed; ConPTY spells it out as CR LF, which lands in the same place.
        this.row = Math.min(this.rows - 1, this.row + 1);
        this.col = 0;
      } else if (ch === '\r') {
        this.col = 0;
      } else if (ch === '\b') {
        this.col = Math.max(0, this.col - 1);
      } else if (ch === '\x07') {
        // bell
      } else {
        const glyph = String.fromCodePoint(data.codePointAt(i) as number);
        // Deferred autowrap, as xterm and conhost do it: a glyph in the last
        // column leaves the cursor pending past it (`col === columns`), and
        // only the next glyph moves to the start of the following row,
        // scrolling when that row is past the bottom. ConPTY relies on this
        // when it repaints several full-width rows in one run.
        if (this.col >= this.columns) {
          this.col = 0;
          if (this.row === this.rows - 1) {
            this.cells.shift();
            this.cells.push(this.blankRow());
          } else {
            this.row += 1;
          }
        }
        (this.cells[this.row] as string[])[this.col] = this.cell(glyph);
        this.col += 1;
        i += glyph.length;
        continue;
      }
      i += 1;
    }
  }

  private csi(params: string, final: string): void {
    if (params.startsWith('?') || params.startsWith('>')) return; // modes: no grid effect
    const nums = params === '' ? [] : params.split(';').map((p) => Number(p || 0));
    const n = Math.max(1, nums[0] ?? 1);
    const current = this.cells[this.row] as string[];
    const column = Math.min(this.col, this.columns - 1);
    switch (final) {
      case 'm':
        this.sgr = applySgr(this.sgr, nums);
        return;
      case 'H':
      case 'f':
        this.row = Math.min(this.rows - 1, Math.max(0, (nums[0] || 1) - 1));
        this.col = Math.min(this.columns - 1, Math.max(0, (nums[1] || 1) - 1));
        return;
      case 'A':
        this.row = Math.max(0, this.row - n);
        return;
      case 'B':
        this.row = Math.min(this.rows - 1, this.row + n);
        return;
      case 'C':
        this.col = Math.min(this.columns - 1, column + n);
        return;
      case 'D':
        this.col = Math.max(0, column - n);
        return;
      case 'G':
        this.col = Math.min(this.columns - 1, n - 1);
        return;
      case 'd':
        this.row = Math.min(this.rows - 1, n - 1);
        return;
      case 'X':
        for (let c = column; c < Math.min(this.columns, column + n); c++) current[c] = this.blank();
        return;
      case 'K': {
        const mode = nums[0] ?? 0;
        const from = mode === 0 ? column : 0;
        const to = mode === 1 ? column + 1 : this.columns;
        for (let c = from; c < to; c++) current[c] = this.blank();
        return;
      }
      case 'J': {
        const mode = nums[0] ?? 0;
        if (mode === 0) {
          for (let c = column; c < this.columns; c++) current[c] = this.blank();
          for (let r = this.row + 1; r < this.rows; r++) this.cells[r] = this.blankRow();
        } else if (mode === 2 || mode === 3) {
          for (let r = 0; r < this.rows; r++) this.cells[r] = this.blankRow();
        } else throw new Error(`unsupported ED ${params}`);
        return;
      }
      default:
        throw new Error(`unsupported CSI ${params}${final}`);
    }
  }

  /** Every cell with its attributes: equal snapshots mean identical screens. */
  snapshot(): string {
    return this.cells.map((row) => row.join('\u0001')).join('\n');
  }

  /** Plain text rows, for readable failure output. */
  text(): string[] {
    return this.cells.map((row) =>
      row
        .map((cell) => cell.slice(cell.indexOf('\u0000') + 1))
        .join('')
        .trimEnd(),
    );
  }
}

/** Deterministic PRNG so a failing sequence can be replayed from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STYLES: ReadonlyArray<readonly [string, string]> = [
  ['', ''],
  [`${ESC}[1m`, `${ESC}[22m`],
  [`${ESC}[38;2;200;50;10m`, `${ESC}[39m`],
  [`${ESC}[48;5;22m`, `${ESC}[49m`],
  [`${ESC}[7m`, `${ESC}[27m`],
];

/**
 * A reproducible sequence of styled frames of `rows` lines, each line at most
 * `columns` wide, where about a quarter of the lines change per frame.
 */
export function buildStyledFrames(
  seed: number,
  columns: number,
  rows: number,
  count: number,
): string[][] {
  const random = mulberry32(seed);
  const pick = (n: number): number => Math.floor(random() * n);
  const makeLine = (): string => {
    const width = pick(columns + 1);
    let line = '';
    let used = 0;
    while (used < width) {
      const [open, close] = STYLES[pick(STYLES.length)] as readonly [string, string];
      const run = Math.min(width - used, 1 + pick(6));
      line += `${open}${'abcdefghij─│█ '.slice(pick(10)).slice(0, 1).repeat(run)}${close}`;
      used += run;
    }
    return line;
  };
  const frames: string[][] = [];
  let lines = Array.from({ length: rows }, makeLine);
  for (let step = 0; step < count; step++) {
    lines = lines.map((line) => (pick(4) === 0 ? makeLine() : line));
    frames.push(lines);
  }
  return frames;
}
