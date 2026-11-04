import { entries, record } from './engine-values';

/** One built-in identity the engine offers, with its system prompt's size. */
export interface IdentityOption {
  variant: string;
  label: string;
  hint: string;
  tokens: number;
}

/**
 * The conversation's identity choices from `system_prompt.info`, and the one it runs: the
 * session's saved preference when there is one, else what the engine reported.
 */
export function sessionIdentity(
  info: unknown,
  prefs: unknown,
): { options: IdentityOption[]; current: string } {
  const payload = record(info);
  const options = entries(payload['variants'])
    .filter((row) => typeof row['variant'] === 'string' && row['variant'])
    .map((row) => ({
      variant: String(row['variant']),
      label:
        typeof row['label'] === 'string' && row['label'] ? row['label'] : String(row['variant']),
      hint: typeof row['hint'] === 'string' ? row['hint'] : '',
      tokens: typeof row['tokens'] === 'number' ? row['tokens'] : 0,
    }));
  const saved = record(prefs)['systemPromptVariant'];
  const reported = payload['current'];
  const current =
    typeof saved === 'string' && saved
      ? saved
      : typeof reported === 'string'
        ? reported
        : (options[0]?.variant ?? '');
  return { options, current };
}

/** `Pro · ~12,400 tokens`, as the WebUI's picker sizes each identity. */
export const identityLabel = (
  option: IdentityOption,
  tokens = (count: string) => `~${count} tokens`,
) =>
  option.tokens > 0
    ? `${option.label} · ${tokens(option.tokens.toLocaleString('en-US'))}`
    : option.label;
