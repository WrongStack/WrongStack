import { color, isStdinTTY, setRawMode } from '@wrongstack/core/utils';
import type { LaunchMenuMode, RunLaunchMenuDeps } from './launch-menu-types.js';
import { MENU_TIMEOUT_MS, MODE_OPTIONS } from './launch-menu-types.js';

/**
 * True when we can take stdin into raw mode for the arrow-key selector.
 * Piped stdin/stdout, test runners, and terminals without setRawMode all
 * fall back to the numbered readline prompt.
 */
function canUseArrowMenu(): boolean {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return false;
  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: unknown };
  return isStdinTTY() && process.stdout.isTTY === true && typeof stdin.setRawMode === 'function';
}

interface ArrowPickResult {
  cancelled: boolean;
  mode: LaunchMenuMode;
}

/**
 * Raw-mode arrow-key selector over {@link MODE_OPTIONS}.
 *
 * Keys: ↑/↓ (or k/j) move, Enter launches, 1–5 jump-launch, q/Esc/Ctrl+C
 * cancel. A live countdown auto-launches the highlighted option after
 * {@link MENU_TIMEOUT_MS}; any keypress stops the countdown. On settle the
 * whole block collapses to a single confirmation line so scrollback stays
 * tidy.
 *
 * Returns `null` when raw mode is unavailable or fails to engage —
 * the caller then runs the numbered readline prompt instead.
 */
export async function promptModeArrow(deps: RunLaunchMenuDeps): Promise<ArrowPickResult | null> {
  if (!canUseArrowMenu()) return null;
  const { renderer } = deps;
  const stdin = process.stdin;
  const out = (s: string): void => renderer.write(s);

  return await new Promise<ArrowPickResult | null>((resolve) => {
    let index = 0;
    let drawn = 0;
    let remaining = Math.round(MENU_TIMEOUT_MS / 1000);
    let countdown = true;
    let settled = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    const wasRaw = stdin.isRaw === true;
    const wasPaused = stdin.isPaused();

    const rows = (): string[] => {
      const lines: string[] = [];
      for (let i = 0; i < MODE_OPTIONS.length; i++) {
        const opt = MODE_OPTIONS[i]!;
        const selected = i === index;
        const pointer = selected ? color.pink('❯') : ' ';
        const label = selected ? color.amber(color.bold(opt.label)) : color.bold(opt.label);
        lines.push(
          `  ${pointer} ${color.dim(String(opt.key))} ${opt.icon}  ${label}  ${color.dim(opt.hint)}`,
        );
      }
      lines.push('');
      const auto = countdown
        ? color.dim(` · auto-launches ${MODE_OPTIONS[index]!.label} in ${remaining}s`)
        : '';
      lines.push(
        `  ${color.dim(`↑↓ move · Enter launch · 1-${MODE_OPTIONS.length} jump · q quit`)}${auto}`,
      );
      return lines;
    };

    const paint = (): void => {
      const lines = rows();
      let frame = drawn > 0 ? `\x1b[${drawn}A` : '';
      frame += `${lines.map((line) => `\x1b[2K${line}`).join('\n')}\n`;
      out(frame);
      drawn = lines.length;
    };

    const stopInput = (): void => {
      if (interval) {
        clearInterval(interval);
        interval = undefined;
      }
      stdin.off('data', onData);
      stdin.off('close', onClose);
      try {
        setRawMode(stdin, wasRaw);
      } catch {
        // Terminal vanished mid-menu — nothing to restore.
      }
      if (wasPaused) stdin.pause();
    };

    const settle = (result: ArrowPickResult, finalLine: string): void => {
      if (settled) return;
      settled = true;
      stopCountdown();
      stopInput();
      // Collapse the menu block to a single line: jump to the block's
      // first row, wipe to end of screen, print the confirmation.
      if (drawn > 0) out(`\x1b[${drawn}A`);
      out('\x1b[0J');
      out(finalLine);
      out('\x1b[?25h');
      resolve(result);
    };

    const pick = (): void => {
      const opt = MODE_OPTIONS[index]!;
      settle(
        { cancelled: false, mode: opt.mode },
        `  ${color.green('✔')} ${opt.icon}  ${color.bold(opt.label)}  ${color.dim(opt.hint)}\n`,
      );
    };

    const cancel = (): void => {
      settle({ cancelled: true, mode: 'tui' }, color.dim('  Goodbye!\n'));
    };

    const stopCountdown = (): void => {
      if (!countdown) return;
      countdown = false;
      if (interval) {
        clearInterval(interval);
        interval = undefined;
      }
    };

    const onData = (buf: Buffer): void => {
      const key = buf.toString('utf8');
      stopCountdown();
      if (key === '\x03' || key === 'q' || key === 'Q' || key === '\x1b') {
        cancel();
        return;
      }
      if (key === '\r' || key === '\n') {
        pick();
        return;
      }
      if (key === '\x1b[A' || key === '\x1bOA' || key === 'k') {
        index = (index + MODE_OPTIONS.length - 1) % MODE_OPTIONS.length;
        paint();
        return;
      }
      if (key === '\x1b[B' || key === '\x1bOB' || key === 'j') {
        index = (index + 1) % MODE_OPTIONS.length;
        paint();
        return;
      }
      if (/^[0-9]$/.test(key)) {
        const digit = Number.parseInt(key, 10);
        if (digit >= 1 && digit <= MODE_OPTIONS.length) {
          index = digit - 1;
          pick();
          return;
        }
      }
      // Unrecognized key — repaint to drop the countdown suffix.
      paint();
    };

    const onClose = (): void => {
      settle({ cancelled: true, mode: 'tui' }, '');
    };

    try {
      setRawMode(stdin, true);
      stdin.resume();
    } catch {
      // Raw mode refused (unusual TTY) — signal fallback.
      resolve(null);
      return;
    }

    out('\x1b[?25l');
    paint();
    stdin.on('data', onData);
    stdin.once('close', onClose);
    interval = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        pick();
        return;
      }
      paint();
    }, 1000);
  });
}
