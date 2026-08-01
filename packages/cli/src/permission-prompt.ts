import { alwaysAllowUnavailableReason } from '@wrongstack/core/security';
import type { InputReader, Tool } from '@wrongstack/core/types';
import { color, truncate, writeOut } from '@wrongstack/core/utils';
import { renderDiff } from './diff-renderer.js';
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

    if (tool.name === 'edit' && hasDiff(input)) {
      const inp = input as { diff?: unknown | undefined };
      const diff = typeof inp.diff === 'string' ? inp.diff : '';
      if (diff) writeOut(`${renderDiff(diff)}\n`);
    }

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
    const alwaysHint = noAlwaysReason
      ? ''
      : `  ${theme.bold('[a]')}lways allow (${suggestedPattern})`;
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
  return Object.entries(obj)
    .filter(([k]) => k !== 'content' && k !== 'new_string')
    .map(([k, v]) => `${k}: ${truncate(JSON.stringify(v), 80)}`)
    .join('  ');
}

function hasDiff(input: unknown): boolean {
  return Boolean(
    input && typeof input === 'object' && 'diff' in (input as Record<string, unknown>),
  );
}
