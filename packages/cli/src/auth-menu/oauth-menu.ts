import { color } from '@wrongstack/core/utils';
import { runClaudeOAuthLogin } from './anthropic-oauth.js';
import { runCopilotOAuthLogin } from './github-copilot-oauth.js';
import { runCodexOAuthLogin } from './openai-codex-oauth.js';
import type { AuthMenuDeps } from './types.js';

/** Render subscription OAuth login choices shared by the top menu and add flow. */
export function renderOAuthLoginOptions(deps: AuthMenuDeps, indent = '    '): void {
  deps.renderer.write(
    `${indent}${color.bold('OAuth login options')} ${color.dim('(subscription sign-in)')}\n` +
      `${indent}${color.bold('chatgpt')}  ChatGPT Plus/Pro  ${color.dim('(→ openai-codex)')}\n` +
      `${indent}${color.bold('claude')}   Claude Pro/Max    ${color.dim('(→ anthropic-oauth)')}\n` +
      `${indent}${color.bold('copilot')}  GitHub Copilot    ${color.dim('(→ github-copilot)')}\n`,
  );
}

export type OAuthMenuKind = 'chatgpt' | 'claude' | 'copilot';

/**
 * Single source of truth for the OAuth vocabulary. Every surface that accepts
 * a subscription name — `wstack auth login <x>`, the OAuth submenu, and the
 * catalog-cancel fallback — resolves through {@link resolveOAuthKind}, so the
 * three never drift into accepting different spellings of the same thing.
 */
const OAUTH_ALIASES: Record<OAuthMenuKind, readonly string[]> = {
  chatgpt: [
    'chatgpt',
    'openai',
    'codex',
    'codex-cli',
    'openai-codex',
    'chatgpt-plus',
    'plus',
    'pro',
  ],
  claude: ['claude', 'anthropic', 'claude-pro', 'claude-max', 'anthropic-oauth', 'max'],
  copilot: ['copilot', 'github', 'gh', 'github-copilot'],
};

const OAUTH_NUMERIC: Record<string, OAuthMenuKind> = {
  '1': 'chatgpt',
  '2': 'claude',
  '3': 'copilot',
};

/**
 * Normalize a user-typed subscription name to an OAuth kind.
 * `allowNumeric` enables the 1/2/3 menu picks (off for free-text prompts,
 * where a bare digit is far more likely to be a typo than a menu choice).
 */
export function resolveOAuthKind(
  choice: string,
  opts: { allowNumeric?: boolean } = {},
): OAuthMenuKind | undefined {
  const pick = choice.trim().toLowerCase();
  if (!pick) return undefined;
  if (opts.allowNumeric !== false && OAUTH_NUMERIC[pick]) return OAUTH_NUMERIC[pick];
  for (const [kind, aliases] of Object.entries(OAUTH_ALIASES)) {
    if (aliases.includes(pick)) return kind as OAuthMenuKind;
  }
  return undefined;
}

/** Run an OAuth login for a normalized menu choice. Returns true when handled. */
export async function runOAuthLoginChoice(
  deps: AuthMenuDeps,
  choice: string,
  opts: { allowNumeric?: boolean } = {},
): Promise<boolean> {
  const kind = resolveOAuthKind(choice, opts);
  if (!kind) return false;
  await runOAuthLoginKind(deps, kind);
  return true;
}

/** Run the OAuth login flow for an already-resolved kind. */
export async function runOAuthLoginKind(deps: AuthMenuDeps, kind: OAuthMenuKind): Promise<number> {
  if (kind === 'claude') return runClaudeOAuthLogin(deps);
  if (kind === 'copilot') return runCopilotOAuthLogin(deps);
  return runCodexOAuthLogin(deps);
}

/** Sub-menu: pick a subscription to sign in with (OAuth). */
export async function runOAuthLoginMenu(deps: AuthMenuDeps): Promise<void> {
  deps.renderer.write(
    `\n  ${color.bold('Login with OAuth:')}\n` +
      color.amber('  ⚠ Subscription tokens used outside official clients may violate provider\n') +
      color.amber('    Terms — your account could be rate-limited or banned. An API key is the\n') +
      color.dim('    sanctioned path for programmatic use.\n') +
      `    ${color.bold('1')}  ChatGPT Plus/Pro  ${color.dim('(→ openai-codex)')}\n` +
      `    ${color.bold('2')}  Claude Pro/Max    ${color.dim('(→ anthropic-oauth)')}\n` +
      `    ${color.bold('3')}  GitHub Copilot    ${color.dim('(→ github-copilot)')}\n`,
  );
  const pick = await deps.reader.readLine(
    `  ${color.amber('?')} Pick ${color.dim('(or b to go back)')}: `,
  );
  await runOAuthLoginChoice(deps, pick);
}
