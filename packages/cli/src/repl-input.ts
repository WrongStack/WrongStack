import { color } from '@wrongstack/core/utils';
import type { ReplOptions } from './repl-options.js';
import { theme } from './theme.js';

/**
 * Read a line, but support two multiline patterns:
 *   1. Trailing `\` → continue on the next line (shell-style line continuation).
 *   2. A line that is exactly `"""` → start a heredoc; keep reading until
 *      another bare `"""`. Useful for pasting code snippets.
 * Returns the assembled text and whether it came from a heredoc block (so
 * the caller can decide to always collapse heredocs as pastes).
 */
export async function readPossiblyMultiline(opts: ReplOptions): Promise<string> {
  const firstPrompt = theme.primary('› ');
  const contPrompt = color.dim('· ');
  const first = await opts.reader.readLine(firstPrompt);

  if (first.trim() === '"""') {
    const parts: string[] = [];
    try {
      for (;;) {
        const next = await opts.reader.readLine(contPrompt);
        if (next.trim() === '"""') break;
        parts.push(next);
      }
    } catch {
      // EOF (Ctrl+D) during heredoc — user typed """ then quit.
      // Return what we have; the outer catch breaks the main loop.
      return parts.join('\n');
    }
    return parts.join('\n');
  }

  let buf = first;
  while (buf.endsWith('\\')) {
    buf = buf.slice(0, -1); // drop the trailing backslash
    const cont = await opts.reader.readLine(contPrompt);
    buf += '\n' + cont;
  }
  return buf;
}
