import { color, sanitizeTerminalText } from '@wrongstack/core/utils';

/**
 * Colorize a single already-sanitized diff line.
 *
 * Exported so callers that must sanitize untrusted text themselves can apply
 * the styling AFTER sanitizing — sanitizing colorized text would strip the
 * colors, and colorizing before sanitizing would leave the untrusted escape
 * sequences in place. See `permission-prompt.ts`.
 */
export function diffLineStyle(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return color.bold(line);
  if (line.startsWith('@@')) return color.cyan(line);
  if (line.startsWith('+')) return color.green(line);
  if (line.startsWith('-')) return color.red(line);
  return color.dim(line);
}

/**
 * Render a diff for terminal display.
 *
 * The diff body can carry model-supplied or file-supplied text, so it is
 * sanitized before styling: a raw `\x1b[2J\x1b[H` in a diff line clears the
 * screen and lets a payload repaint the surrounding UI — including an approval
 * prompt's header.
 */
export function renderDiff(diff: string): string {
  if (!diff) return '';
  return sanitizeTerminalText(diff).split('\n').map(diffLineStyle).join('\n');
}
