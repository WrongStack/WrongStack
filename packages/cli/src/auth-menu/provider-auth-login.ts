import type { ProviderAuthRegistry } from '@wrongstack/core/registry';
import { color } from '@wrongstack/core/utils';
import {
  applyProviderAuthOutcome,
  createBuiltinProviderAuthRegistry,
} from '@wrongstack/providers/oauth';
import { mutateConfigProviders } from '../provider-config-utils.js';
import { openBrowser } from './loopback-server.js';
import type { AuthMenuDeps } from './types.js';

let defaultRegistry: ProviderAuthRegistry | undefined;

type ProviderAuthRegistrySource = Pick<AuthMenuDeps, 'providerAuthRegistry'>;

export function providerAuthRegistryFor(deps: ProviderAuthRegistrySource): ProviderAuthRegistry {
  if (deps.providerAuthRegistry) return deps.providerAuthRegistry;
  defaultRegistry ??= createBuiltinProviderAuthRegistry();
  return defaultRegistry;
}

/** UI-safe strategy metadata shared by the TUI auth panel and CLI menus. */
export function providerAuthStrategiesFor(deps: ProviderAuthRegistrySource) {
  return providerAuthRegistryFor(deps).list();
}

function hyperlink(url: string): string {
  return `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`;
}

export async function runProviderAuthLogin(
  deps: AuthMenuDeps,
  strategyId: string,
  opts: { providerId?: string | undefined; signal?: AbortSignal | undefined } = {},
): Promise<number> {
  const registry = providerAuthRegistryFor(deps);
  const strategy = registry.get(strategyId);
  if (!strategy) {
    deps.renderer.writeError(`Unknown OAuth login "${strategyId}".`);
    return 1;
  }

  const controller = new AbortController();
  let sigintCount = 0;
  const onSigint = () => {
    sigintCount += 1;
    if (sigintCount === 1) {
      deps.renderer.write(
        color.dim('\n  Cancelling sign-in… (press Ctrl+C again to force-quit)\n'),
      );
      controller.abort();
    } else {
      process.exit(130);
    }
  };
  const onExternalAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
  } else {
    process.on('SIGINT', onSigint);
  }

  let session: Awaited<ReturnType<ProviderAuthRegistry['begin']>> | undefined;
  try {
    deps.renderer.write(
      color.bold(`\n  Sign in with ${strategy.label}`) +
        color.dim(` → ${opts.providerId ?? strategy.providerId}\n`),
    );
    session = await registry.begin(
      strategy.id,
      { modelsRegistry: deps.modelsRegistry },
      controller.signal,
    );

    let outcome;
    if (session.interaction.type === 'device_code') {
      const { verificationUri, userCode } = session.interaction;
      deps.renderer.write(
        color.bold('\n  Open this URL and enter the code:\n') +
          color.cyan(`  ${hyperlink(verificationUri)}\n`) +
          color.bold(`  Code: ${userCode}\n`) +
          color.dim('  Waiting for authorization…\n'),
      );
      openBrowser(verificationUri);
      outcome = await session.waitForCompletion(controller.signal);
    } else {
      const { authorizeUrl, bound } = session.interaction;
      deps.renderer.write(
        color.bold('\n  Open this URL in your browser to sign in:\n') +
          color.cyan(`  ${hyperlink(authorizeUrl)}\n`),
      );
      if (bound) {
        openBrowser(authorizeUrl);
        deps.renderer.write(color.dim('  Waiting for browser authorization…\n'));
        outcome = await session.waitForCompletion(controller.signal);
      } else {
        const input = (
          await deps.reader.readLine(
            `\n  ${color.amber('?')} Paste the redirect URL or code ${color.dim('(or q to cancel)')}: `,
          )
        ).trim();
        if (!input || input.toLowerCase() === 'q') return 1;
        outcome = await session.completeWithCode(input, controller.signal);
      }
    }

    if (!outcome) {
      deps.renderer.write(color.dim('  Sign-in cancelled or timed out.\n'));
      return 1;
    }
    await mutateConfigProviders(
      deps.profileConfigPath,
      deps.vault,
      (providers) => {
        applyProviderAuthOutcome(providers, outcome, { targetProviderId: opts.providerId });
      },
      deps.profileConfigPath,
    );
    const savedId = opts.providerId ?? outcome.providerId;
    deps.renderer.write(color.green(`\n  ✓ Signed in — saved as ${savedId}.\n`));
    return 0;
  } catch (error) {
    const message =
      error instanceof DOMException && error.name === 'AbortError'
        ? 'Login cancelled.'
        : error instanceof Error
          ? error.message
          : String(error);
    deps.renderer.writeError(`  Login failed: ${message}`);
    return 1;
  } finally {
    session?.close();
    if (opts.signal) opts.signal.removeEventListener('abort', onExternalAbort);
    else process.off('SIGINT', onSigint);
  }
}
