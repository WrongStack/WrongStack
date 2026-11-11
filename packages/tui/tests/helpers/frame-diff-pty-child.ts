/**
 * Child process for frame-diff-conpty.test.ts. Runs inside a real pseudo
 * console and writes a reproducible sequence of full-screen frames the way Ink
 * does on Windows, either whole or through the frame differ.
 *
 * Usage: bun frame-diff-pty-child.ts <whole|diff> <seed> <frameCount>
 */
import { createFrameDiffStdout, INK_FULL_FRAME_PREFIX } from '../../src/frame-diff-stdout.js';
import { buildStyledFrames } from './vt-screen.js';

const [mode, seedArg, countArg] = process.argv.slice(2);
const seed = Number(seedArg);
const count = Number(countArg);
const columns = process.stdout.columns;
const rows = process.stdout.rows;
if (!columns || !rows || !Number.isFinite(seed) || !Number.isFinite(count)) {
  process.stderr.write('frame-diff-pty-child: needs a TTY and <mode> <seed> <count>\n');
  process.exit(2);
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// No healing repaint: an error the differ makes must survive to the last frame.
const out =
  mode === 'diff'
    ? createFrameDiffStdout(process.stdout, { fullRepaintMs: Number.POSITIVE_INFINITY }).stream
    : process.stdout;

// The TUI's own startup: alternate screen, cleared, cursor hidden.
process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l');
const frames = buildStyledFrames(seed, columns, rows, count);
for (let index = 0; index < frames.length; index++) {
  out.write(INK_FULL_FRAME_PREFIX + (frames[index] as string[]).join('\n'));
  // Let the console render some intermediate states rather than only the last.
  if (index % 8 === 7) await pause(15);
}
// Give the pseudo console time to emit its final screen before the pipe closes.
await pause(250);
process.exit(0);
