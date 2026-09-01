/**
 * First-run gate — the screen a user sees when WrongStack has no way to reach
 * a model yet.
 *
 * WHY IT IS A SEPARATE SCREEN. The launch picker lists the models.dev catalog:
 * ~190 providers, almost all of them unknown to a newcomer, none of them
 * usable without a credential. Dropping a first-time user into that list is a
 * dead end — every choice leads to a session whose first request fails, and
 * cancelling exits the process before the TUI (and therefore `/auth`) is ever
 * reachable. This gate runs BEFORE the picker and only when nothing is
 * configured, so the catalog wall is never a newcomer's first impression.
 *
 * The four options are the four real ways to get a working model, plus a
 * no-credential escape hatch (setup mode) so the app is always enterable.
 * Options 1–3 delegate to the same auth-menu flows `wstack auth` uses, so
 * there is no second implementation of any credential path here.
 */
import { hasProviderCredential } from '@wrongstack/core/models';
import type { Config, ModelsRegistry, SecretVault } from '@wrongstack/core/types';
import { color, toErrorMessage } from '@wrongstack/core/utils';
import { PROVIDER_DEFINITIONS } from '@wrongstack/providers/definitions';
import { addFromCatalog } from '../auth-menu/add-provider.js';
import { runAuthLocal } from '../auth-menu/local.js';
import { runOAuthLoginMenu } from '../auth-menu/oauth-menu.js';
import type { AuthMenuDeps } from '../auth-menu/types.js';
import type { ReadlineInputReader } from '../input-reader.js';
import { boxBottom, boxDivider, boxRow, boxTop, theme } from '../picker-ui.js';
import { isKeylessLocalProvider } from '../provider-helpers.js';
import { resolveActiveApiKey } from '../provider-config-utils.js';
import type { TerminalRenderer } from '../renderer.js';

/**
 * Does this machine have ANY way to reach a model right now?
 *
 * Three independent sources, checked cheapest-first:
 *   1. A saved provider carrying a key or an OAuth token (`apiKeys[]`), or a
 *      keyless loopback gateway (Ollama / LM Studio / vLLM / OmniRoute).
 *   2. An env var named by a provider WrongStack ships a definition for. This
 *      list is local and always complete, so it answers correctly offline and
 *      even when the catalog has been pruned.
 *   3. An env var named by a catalog provider — covers providers that exist
 *      only in models.dev. Skipped without complaint when the catalog is
 *      unavailable; sources 1 and 2 already cover the common cases.
 *
 * Deliberately generous: a false positive only means the user sees the normal
 * picker (which they can still act on), while a false negative would push a
 * configured user through an onboarding screen they do not need.
 */
export async function hasAnyCredential(
  config: Config,
  modelsRegistry: ModelsRegistry,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<boolean> {
  for (const cfg of Object.values(config.providers ?? {})) {
    if (!cfg) continue;
    if (resolveActiveApiKey(cfg) !== undefined) return true;
    if (isKeylessLocalProvider({ apiBase: cfg.baseUrl, envVars: cfg.envVars })) return true;
    // A saved entry naming its own env vars counts when one of them is set.
    if ((cfg.envVars ?? []).some((name) => !!env[name])) return true;
  }

  for (const definition of Object.values(PROVIDER_DEFINITIONS)) {
    if (definition.envVars.some((name) => !!env[name])) return true;
  }

  try {
    const catalog = await modelsRegistry.listProviders();
    for (const provider of catalog) {
      if (hasProviderCredential(provider, config, env)) return true;
    }
  } catch {
    // Catalog unavailable — the two local sources above already answered.
  }
  return false;
}

export type FirstRunOutcome =
  /** A credential was added. The caller must reload config from disk. */
  | { kind: 'configured' }
  /** User chose to continue with no model connected. */
  | { kind: 'setup-mode' }
  /** User quit. The caller should exit 0 — this is not an error. */
  | { kind: 'quit' };

export interface FirstRunDeps {
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  modelsRegistry: ModelsRegistry;
  vault: SecretVault;
  profileConfigPath: string;
  /** Re-read after each auth flow so the loop can tell whether it succeeded. */
  reloadConfig: () => Promise<Config>;
}

function renderWelcome(renderer: TerminalRenderer): void {
  renderer.write('\n');
  renderer.write(`${boxTop('Welcome to WrongStack')}\n`);
  renderer.write(
    `${boxRow(color.dim('No model is connected yet. Pick how you want to connect one:'))}\n`,
  );
  renderer.write(`${boxDivider()}\n`);
  renderer.write(
    `${boxRow(
      `${theme.accent('1')}  ${color.bold('Sign in with a subscription')}  ${color.dim('ChatGPT · Claude · GitHub Copilot')}`,
    )}\n`,
  );
  renderer.write(
    `${boxRow(
      `${theme.accent('2')}  ${color.bold('Add an API key')}              ${color.dim('Anthropic · OpenAI · Google · OpenRouter · …')}`,
    )}\n`,
  );
  renderer.write(
    `${boxRow(
      `${theme.accent('3')}  ${color.bold('Use a local server')}          ${color.dim('Ollama · LM Studio · vLLM · OmniRoute')}`,
    )}\n`,
  );
  renderer.write(
    `${boxRow(
      `${theme.accent('4')}  ${color.bold('Continue without a key')}      ${color.dim('setup mode — explore the app, no model')}`,
    )}\n`,
  );
  renderer.write(`${boxDivider()}\n`);
  renderer.write(
    `${boxRow(color.dim('You can change this any time with /auth inside the app, or `wstack auth`.'))}\n`,
  );
  renderer.write(`${boxBottom()}\n`);
}

/**
 * Run the first-run gate. Loops until the user configures a credential,
 * chooses setup mode, or quits — a failed or abandoned auth flow returns here
 * rather than falling through to the picker, which would be the same dead end
 * this screen exists to remove.
 */
export async function runFirstRunSetup(deps: FirstRunDeps): Promise<FirstRunOutcome> {
  const { renderer, reader } = deps;
  const authDeps: AuthMenuDeps = {
    renderer,
    reader,
    modelsRegistry: deps.modelsRegistry,
    vault: deps.vault,
    profileConfigPath: deps.profileConfigPath,
  };

  for (;;) {
    renderWelcome(renderer);
    const answer = (
      await reader.readLine(
        `\n${color.amber('?')} Choose ${color.dim('(1-4)')} ${color.dim('[q to quit]')}: `,
      )
    )
      .trim()
      .toLowerCase();

    if (!answer || answer === 'q' || answer === 'quit' || answer === 'exit') {
      renderer.write(
        `\n  ${color.dim('No provider configured. Run')} ${color.bold('wstack auth')} ${color.dim('when you are ready.')}\n\n`,
      );
      return { kind: 'quit' };
    }

    if (answer === '4' || answer === 'setup' || answer === 'skip') {
      return { kind: 'setup-mode' };
    }

    // Wrapped rather than passed by reference: the three flows have different
    // arities and return types, and a union of their signatures is not
    // callable. Each wrapper pins the one call shape this gate uses.
    const flow: (() => Promise<unknown>) | undefined =
      answer === '1' || answer === 'signin' || answer === 'login'
        ? () => runOAuthLoginMenu(authDeps)
        : answer === '2' || answer === 'key' || answer === 'api'
          ? () => addFromCatalog(authDeps)
          : answer === '3' || answer === 'local'
            ? () => runAuthLocal(authDeps)
            : undefined;

    if (!flow) {
      renderer.writeError(`Unknown selection: "${answer}"`);
      continue;
    }

    try {
      await flow();
    } catch (err) {
      // Every auth flow treats a rejected prompt as user-cancel; a genuine
      // failure must not take the process down before the user has any way in.
      renderer.writeWarning(`Setup step did not complete: ${toErrorMessage(err)}\n`);
    }

    // Re-read from disk: the auth flows wrote there, not to our in-memory copy.
    let updated: Config;
    try {
      updated = await deps.reloadConfig();
    } catch (err) {
      renderer.writeWarning(`Could not re-read config: ${toErrorMessage(err)}\n`);
      continue;
    }
    if (await hasAnyCredential(updated, deps.modelsRegistry)) {
      return { kind: 'configured' };
    }
    renderer.writeWarning('Still no usable credential — pick another option.\n');
  }
}
