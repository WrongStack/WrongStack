import { ERROR_CODES, type WrongStackError } from '@wrongstack/contracts/types';

const CONTEXT_OVERFLOW_RE = /context window|exceeds the context|too many tokens|context.*tokens/i;

export function contextOverflowHint(err: WrongStackError): string | null {
  if (!err || typeof err !== 'object') return null;

  const structured =
    err.code === ERROR_CODES.PROVIDER_CONTEXT_OVERFLOW ||
    err.code === ERROR_CODES.AGENT_CONTEXT_OVERFLOW;
  const desc = typeof err.describe === 'function' ? err.describe() : '';
  const message = typeof err.message === 'string' ? err.message : '';
  const textual = CONTEXT_OVERFLOW_RE.test(`${message}\n${desc}`);
  if (!structured && !textual) return null;

  return [
    'Provider rejected the request as over its effective context window.',
    'If you use a custom baseUrl/proxy, the real limit may be lower than models.dev reports.',
    'Try: /context limit 220k',
    'Then, if needed: /context thresholds 50% 70% 85%',
    'Persistent config: set context.effectiveMaxContext.',
  ].join('\n');
}
