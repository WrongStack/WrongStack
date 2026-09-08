import { color } from '@wrongstack/core/utils';
import { providerAuthRegistryFor, runProviderAuthLogin } from './provider-auth-login.js';
import type { AuthMenuDeps } from './types.js';

/** Render subscription OAuth login choices shared by the top menu and add flow. */
export function renderOAuthLoginOptions(deps: AuthMenuDeps, indent = '    '): void {
  const entries = providerAuthRegistryFor(deps).list();
  deps.renderer.write(
    `${indent}${color.bold('OAuth login options')} ${color.dim('(browser / device sign-in)')}\n` +
      entries
        .map(
          (entry) =>
            `${indent}${color.bold(entry.id.padEnd(10))} ${entry.label}  ${color.dim(`(→ ${entry.providerId})`)}\n`,
        )
        .join(''),
  );
}

/** Strategy ids are runtime-extensible; this alias preserves the public CLI name. */
export type OAuthMenuKind = string;

/**
 * Normalize a user-typed subscription name to an OAuth kind.
 * `allowNumeric` enables the 1/2/3 menu picks (off for free-text prompts,
 * where a bare digit is far more likely to be a typo than a menu choice).
 */
export function resolveOAuthKind(
  choice: string,
  opts: { allowNumeric?: boolean; deps?: AuthMenuDeps | undefined } = {},
): OAuthMenuKind | undefined {
  const pick = choice.trim().toLowerCase();
  if (!pick) return undefined;
  const registry = opts.deps ? providerAuthRegistryFor(opts.deps) : providerAuthRegistryFor({});
  if (opts.allowNumeric !== false && /^\d+$/.test(pick)) {
    return registry.list()[Number(pick) - 1]?.id;
  }
  return registry.resolveId(pick);
}

/** Run an OAuth login for a normalized menu choice. Returns true when handled. */
export async function runOAuthLoginChoice(
  deps: AuthMenuDeps,
  choice: string,
  opts: { allowNumeric?: boolean } = {},
): Promise<boolean> {
  const kind = resolveOAuthKind(choice, { ...opts, deps });
  if (!kind) return false;
  await runOAuthLoginKind(deps, kind);
  return true;
}

/** Run the OAuth login flow for an already-resolved kind. */
export async function runOAuthLoginKind(deps: AuthMenuDeps, kind: OAuthMenuKind): Promise<number> {
  return runProviderAuthLogin(deps, kind);
}

/** Sub-menu: pick a subscription to sign in with (OAuth). */
export async function runOAuthLoginMenu(deps: AuthMenuDeps): Promise<void> {
  const entries = providerAuthRegistryFor(deps).list();
  deps.renderer.write(
    `\n  ${color.bold('Login with OAuth:')}\n` +
      color.amber('  ⚠ Subscription authentication may be governed by provider-specific terms.\n') +
      entries
        .map(
          (entry, index) =>
            `    ${color.bold(String(index + 1))}  ${entry.label}  ${color.dim(`(→ ${entry.providerId})`)}\n`,
        )
        .join(''),
  );
  const pick = await deps.reader.readLine(
    `  ${color.amber('?')} Pick ${color.dim('(or b to go back)')}: `,
  );
  await runOAuthLoginChoice(deps, pick);
}
