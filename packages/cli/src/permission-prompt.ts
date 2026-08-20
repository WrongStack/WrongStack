import { alwaysAllowUnavailableReason } from '@wrongstack/core/security';
import type { InputReader, Tool } from '@wrongstack/core/types';
import {
  color,
  sanitizeTerminalPreview,
  sanitizeTerminalText,
  truncate,
  unifiedDiff,
  writeOut,
} from '@wrongstack/core/utils';
import { diffLineStyle } from './diff-renderer.js';
import { theme } from './theme.js';

export type PromptDecision = 'yes' | 'no' | 'always' | 'deny';

/** Signature the Agent expects for confirming tool calls. */
export type ConfirmAwaiter = (
  tool: Tool,
  input: unknown,
  toolUseId: string,
  suggestedPattern: string,
) => Promise<'yes' | 'no' | 'always' | 'deny'>;

export function makePromptDelegate(reader: InputReader) {
  return async (tool: Tool, input: unknown, suggestedPattern: string): Promise<PromptDecision> => {
    // Terminal bell (\x07) to alert the user that action is required.
    // Without this, the prompt can be easily missed when output is
    // scrolling or the user has switched to another window.
    writeOut('\x07');
    writeOut(
      `\n${theme.warn('⚠ APPROVAL REQUIRED')} ${theme.primary('│')} ${theme.bold(tool.name)}\n`,
    );
    writeOut(`${color.dim(stringifyInput(input))}\n`);

    // Not gated on tool.name: `write`, `edit`, and any future mutating tool
    // that carries a payload must all show it. The previous check was
    // `tool.name === 'edit' && hasDiff(input)`, and hasDiff was never true.
    const preview = renderPayloadPreview(input);
    if (preview) writeOut(`${preview}\n`);

    writeOut(color.dim('─────────────────\n'));

    // WS-046: "always allow" is only offerable when the call carries a subject
    // to remember. Without one, the trust file has nothing to key a rule on and
    // the entry would be written but never matched — so the option is withheld
    // and the reason shown, instead of presenting a choice that does nothing.
    // Offering a dead option is worse than not offering it: the user concludes
    // trust rules are broken and reaches for a blanket auto-approve.
    const noAlwaysReason = alwaysAllowUnavailableReason(tool, input);
    if (noAlwaysReason) {
      writeOut(`${color.dim(`(no "always" for this call — ${noAlwaysReason})`)}\n`);
    }

    const options = [
      { key: 'y', label: 'yes', value: 'yes' },
      { key: 'n', label: 'no', value: 'no' },
      ...(noAlwaysReason ? [] : [{ key: 'a', label: 'always', value: 'always' }]),
      { key: 'd', label: 'deny', value: 'deny' },
    ];
    // `suggestedPattern` is derived from tool input, so it reaches the terminal
    // carrying whatever the model put there. `escapeGlobSubject` neutralizes
    // CSI/OSC only incidentally (it escapes `[` and `]`); two-character forms
    // like `ESC c` — a full terminal reset — pass straight through.
    const alwaysHint = noAlwaysReason
      ? ''
      : `  ${theme.bold('[a]')}lways allow (${sanitizeTerminalText(suggestedPattern)})`;
    const answer = await reader.readKey(
      `${theme.bold('[y]')}es  ${theme.bold('[n]')}o${alwaysHint}  ${theme.bold('[d]')}eny: `,
      options,
    );
    return answer as PromptDecision;
  };
}

/**
 * Create a ConfirmAwaiter for the CLI path. Wraps makePromptDelegate
 * with the ConfirmAwaiter type signature expected by the Agent.
 */
export function makeConfirmAwaiter(reader: InputReader): ConfirmAwaiter {
  const delegate = makePromptDelegate(reader);
  return async (tool: Tool, input: unknown, _toolUseId: string, suggestedPattern: string) => {
    const result = await delegate(tool, input, suggestedPattern);
    return result as 'yes' | 'no' | 'always' | 'deny';
  };
}

function stringifyInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  return (
    Object.entries(obj)
      .filter(([k]) => k !== 'content' && k !== 'new_string')
      // JSON.stringify escapes ESC/CR/LF but NOT bidi or zero-width controls, so
      // it is not sufficient on its own to keep the rendered value honest.
      .map(([k, v]) => `${k}: ${truncate(sanitizeTerminalText(JSON.stringify(v)), 80)}`)
      .join('  ')
  );
}

/**
 * Longest payload preview shown before an approval. A cap is unavoidable for a
 * terminal prompt, but a SILENT cap would recreate the bug being fixed, so the
 * renderer always states how much it withheld.
 *
 * The character cap matters as much as the line cap: a line limit alone is not
 * a bound, because a single 200,000-character line satisfies it and can still
 * scroll this prompt off the screen.
 */
const PREVIEW_MAX_LINES = 40;
const PREVIEW_MAX_CHARS = 8_000;

/**
 * Sanitize and clip untrusted preview text, then colorize it line by line.
 *
 * Order is load-bearing. The text arrives from the model, so it is sanitized
 * FIRST — before any of our own escape sequences are added — otherwise the
 * sanitizer would strip the colors we just applied. `decorate` therefore only
 * ever sees text that can no longer move the cursor or repaint the screen.
 */
function clipPreview(body: string, decorate: (line: string) => string = (l) => l): string {
  const safe = sanitizeTerminalText(body);
  const { text, truncated } = sanitizeTerminalPreview(body, {
    maxLines: PREVIEW_MAX_LINES,
    maxChars: PREVIEW_MAX_CHARS,
  });
  const rendered = text.split('\n').map(decorate).join('\n');
  if (!truncated) return rendered;

  // Say what was withheld, in the dimension that actually did the withholding.
  // A silent cap would recreate the class of bug this preview exists to fix.
  const hiddenLines = safe.split('\n').length - text.split('\n').length;
  const detail =
    hiddenLines > 0
      ? `${hiddenLines} more line${hiddenLines === 1 ? '' : 's'} not shown`
      : `${safe.length - text.length} more characters not shown`;
  return `${rendered}\n${color.dim(`… ${detail} — review the file before approving`)}`;
}

/**
 * Render the payload a mutating tool is about to write.
 *
 * `stringifyInput` strips `content` and `new_string` so the one-line summary
 * stays readable. The compensating branch that was meant to restore them keyed
 * on `input.diff` — but `diff` exists only on EditOutput, never on EditInput,
 * and nothing enriches the input before the prompt sees it. So it was dead code
 * and the user approved edits and whole-file writes having seen only a path
 * (WS-080).
 *
 * For `edit` the diff is synthesised from the two strings the tool was given.
 * For `write` there is no "before" to diff against, so the content is shown.
 */
function renderPayloadPreview(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;

  const newString = obj['new_string'];
  if (typeof newString === 'string') {
    // `old_string` absent is treated as an insertion rather than as a reason to
    // show nothing: a malformed or partial payload is exactly when the user most
    // needs to see what will be written.
    const oldString = typeof obj['old_string'] === 'string' ? obj['old_string'] : '';
    const diff = unifiedDiff(oldString, newString, {
      fromFile: 'before',
      toFile: 'after',
      context: 2,
    });
    return diff ? clipPreview(diff, diffLineStyle) : color.dim('(replacement is identical)');
  }

  const content = obj['content'];
  if (typeof content === 'string') {
    if (content === '') return color.dim('(writes an empty file)');
    return clipPreview(content, (line) => color.dim('│ ') + line);
  }

  // A caller that genuinely supplies a prebuilt diff still renders.
  const diff = obj['diff'];
  return typeof diff === 'string' && diff ? clipPreview(diff, diffLineStyle) : '';
}
