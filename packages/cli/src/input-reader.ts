import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';
import {
  type InputReader,
  type PromptOption,
  setOutputLineGuard,
  setRawMode,
  writeOut,
  wstackGlobalRoot,
} from '@wrongstack/core';

export interface ReadlineInputReaderOptions {
  historyFile?: string | undefined;
  prompt?: string | undefined;
}

export class ReadlineInputReader implements InputReader {
  private rl?: readline.Interface | undefined;
  private readonly historyFile: string;
  private history: string[] = [];
  private pending = false;

  constructor(opts: ReadlineInputReaderOptions = {}) {
    this.historyFile = opts.historyFile ?? path.join(wstackGlobalRoot(), 'history');
  }

  private async loadHistory(): Promise<void> {
    try {
      const raw = await fs.readFile(this.historyFile, 'utf8');
      this.history = raw.split('\n').filter(Boolean).slice(-1000);
    } catch {
      this.history = [];
    }
  }

  private async saveHistory(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.historyFile), { recursive: true });
      await fs.writeFile(this.historyFile, this.history.slice(-1000).join('\n'));
    } catch {
      // ignore
    }
  }

  private ensure(): readline.Interface {
    if (!this.rl) {
      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        history: this.history,
        terminal: process.stdin.isTTY,
      });
    }
    return this.rl;
  }

  async readLine(
    prompt?: string,
    timeoutOpts?: { timeoutMs: number; defaultAnswer: string } | undefined,
  ): Promise<string> {
    if (this.history.length === 0) await this.loadHistory();
    while (this.pending) {
      // Wait for the current read to settle before accepting another.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    this.pending = true;
    try {
      // Tear down any stale interface *and await its full close event*
      // before creating a replacement.  On Windows, readline listeners
      // linger past .close() — if the new interface attaches while the
      // old one is still draining, both fire for every keystroke and the
      // user sees every typed character doubled (5→55, 2→22).
      if (this.rl) {
        const old = this.rl;
        this.rl = undefined;
        await new Promise<void>((resolve) => {
          // If the interface is already closed/closing the 'close' event
          // may fire synchronously or on the next tick — the promise
          // handles both.
          if ((old as never as { closed?: boolean | undefined }).closed) {
            resolve();
          } else {
            old.once('close', resolve);
            old.close();
          }
        });
      }
      const fresh = this.ensure();
      // While this prompt is on screen, bracket every out-of-band write
      // (logger WARN/INFO, async Telegram activity) so it can't strand the
      // half-typed draft in scrollback. Cleared the moment the read settles.
      this.installPromptGuard(fresh);
      return new Promise<string>((resolve) => {
        let settled = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

        const settle = (line: string): void => {
          if (settled) return;
          settled = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          setOutputLineGuard(null);
          resolve(line);
        };

        // When a timeout is configured, auto-feed the default answer
        // after `timeoutMs` milliseconds.  `fresh.write()` programmatically
        // feeds the readline parser as if the user typed it — the question
        // callback fires naturally and the default text appears on screen
        // so the user sees what happened.
        if (timeoutOpts) {
          timeoutHandle = setTimeout(() => {
            if (!settled) {
              fresh.write(`${timeoutOpts.defaultAnswer}\n`);
            }
          }, timeoutOpts.timeoutMs);
        }

        fresh.question(prompt ?? '> ', (line) => {
          if (line.trim()) {
            this.history.push(line);
            // Fire-and-forget: saveHistory logs its own errors; we intentionally
            // don't await or .catch() here — failing to write history must not
            // block the user input path. Using the two-arg .then() form (not
            // .catch()) so TypeScript flags if the Promise type ever changes.
            this.saveHistory().then(undefined, () => {
              /* intentionally empty */
            });
          }
          settle(line);
        });
        // Ctrl+C closes the readline interface — resolve with empty
        // string so callers treat it as cancel instead of crashing with
        // an unhandled EOF error.
        fresh.once('close', () => settle(''));
        // Handle any unexpected throw inside the executor by settling to
        // empty string so callers treat it as cancel rather than crashing.
        fresh.on?.('error', (_e: unknown) => settle(''));
      }).then((result) => {
        // Close the interface so the next readLine call tears it down
        // first (see the guard above).  On Windows / Node ≥ 24 the
        // interface can enter an internally-closed state after
        // question() resolves; reusing it throws ERR_USE_AFTER_CLOSE.
        this.rl?.close();
        return result;
      });
    } finally {
      this.pending = false;
    }
  }

  /**
   * Install the out-of-band write guard for the active prompt. When a log
   * line or other async output lands while the user is mid-type, the guard
   * clears the draft row, lets the message print, then repaints the prompt
   * and the in-progress draft (cursor preserved) via readline's own
   * refresh. Without it, each async write leaves the half-typed line
   * stranded as a fresh scrollback row.
   *
   * No-op on non-TTY output (piped/redirected) — there's no draft to
   * protect and the ANSI clear/repaint would be noise in a file.
   */
  private installPromptGuard(rl: readline.Interface): void {
    const out = process.stdout;
    if (!out.isTTY) {
      setOutputLineGuard(null);
      return;
    }
    setOutputLineGuard({
      suspend(): void {
        // Carriage-return to column 0 and erase the whole row so the
        // out-of-band line prints onto clean terminal space.
        readline.cursorTo(out, 0);
        readline.clearLine(out, 0);
      },
      resume(): void {
        // `prompt(true)` re-emits the prompt + current line buffer and
        // restores the cursor column, so editing-in-place survives the
        // interruption. Guarded: the interface may have closed between the
        // write being issued and this callback firing.
        try {
          rl.prompt(true);
        } catch {
          // readline closed mid-write — nothing left to repaint.
        }
      },
    });
  }

  async readKey(prompt: string, options: PromptOption[]): Promise<string> {
    // This flow drives stdin directly; no readline prompt to protect.
    setOutputLineGuard(null);
    writeOut(prompt);
    return new Promise<string>((resolve) => {
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw;
      const wasPaused = stdin.isPaused();
      setRawMode(stdin, true);
      stdin.resume();
      const onData = (buf: Buffer) => {
        const key = buf.toString();
        // Ctrl+C — treat as cancel (resolve with empty string).
        if (key === '\x03') {
          cleanup();
          writeOut('\n');
          resolve('');
          return;
        }
        const opt = options.find(
          (o) => o.key.toLowerCase() === key.toLowerCase() || o.value === key,
        );
        if (opt) {
          cleanup();
          writeOut(`${opt.key}\n`);
          resolve(opt.value);
        }
      };
      const onClose = () => {
        cleanup();
        resolve('');
      };
      const cleanup = () => {
        stdin.off('data', onData);
        stdin.off('close', onClose);
        setRawMode(stdin, wasRaw);
        if (wasPaused) stdin.pause();
      };
      stdin.on('data', onData);
      stdin.on('close', onClose);
    });
  }

  /**
   * Read a line of input while masking each character with a bullet so the
   * user gets visual confirmation that bytes are arriving (especially on
   * paste, which previously felt like nothing happened). Pasted chunks
   * are echoed as a run of bullets, Backspace/DEL erases one bullet, and
   * Ctrl+U / Ctrl+T are honored. Non-TTY input is read normally — there's
   * nothing to hide when piped, and echoing bullets to a file is noise.
   *
   * Returns the raw entered string (no trim — caller decides).
   */
  async readSecret(prompt: string): Promise<string> {
    const stdin = process.stdin;
    if (!stdin.isTTY) return this.readLine(prompt);
    // Tear down the active readline so we can take over stdin.
    setOutputLineGuard(null);
    this.rl?.close();
    this.rl = undefined;
    writeOut(prompt);
    return new Promise<string>((resolve) => {
      let buf = '';
      const wasRaw = stdin.isRaw;
      setRawMode(stdin, true);
      stdin.resume();
      stdin.setEncoding('utf8');

      const eraseChar = () => {
        // Move cursor back, overwrite with space, move back again.
        writeOut('\b \b');
      };
      const eraseAll = () => {
        for (let i = 0; i < buf.length; i++) eraseChar();
      };

      const onData = (chunk: string) => {
        // Process the whole chunk at once — paste arrives as one event.
        // We walk char-by-char so embedded control bytes (e.g. a stray
        // CR inside a paste) terminate input cleanly.
        for (const ch of chunk) {
          if (ch === '\r' || ch === '\n') {
            cleanup();
            writeOut(`  ${dim(`[${buf.length} chars]`)}\n`);
            resolve(buf);
            return;
          }
          if (ch === '') {
            // Ctrl+C
            cleanup();
            writeOut('\n');
            process.exit(130);
          }
          if (ch === '') {
            // Ctrl+U — clear line
            eraseAll();
            buf = '';
            continue;
          }
          if (ch === '') {
            // Ctrl+T — erase last whitespace-delimited token
            const m = buf.match(/(\S+\s*)$/);
            const drop = m ? m[0].length : buf.length;
            for (let i = 0; i < drop; i++) eraseChar();
            buf = buf.slice(0, buf.length - drop);
            continue;
          }
          if (ch === '' || ch === '\b') {
            if (buf.length > 0) {
              buf = buf.slice(0, -1);
              eraseChar();
            }
            continue;
          }
          // Skip other control bytes silently (escape sequences, etc.).
          if (ch < ' ') continue;
          buf += ch;
          writeOut('•');
        }
      };
      const cleanup = () => {
        stdin.off('data', onData);
        setRawMode(stdin, wasRaw);
        stdin.pause();
      };
      stdin.on('data', onData);
    });
  }

  async close(): Promise<void> {
    setOutputLineGuard(null);
    await this.saveHistory();
    this.rl?.close();
    this.rl = undefined;
  }
}

// Local ANSI dim — kept inline so this module has no @wrongstack/core
// dependency for its single visual flourish.
function dim(s: string): string {
  if (!process.stdout.isTTY) return s;
  return `[2m${s}[22m`;
}
