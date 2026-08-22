/**
 * Modeldiag live smoke-test subcommand handler.
 *
 * @module subcommands/handlers/modeldiag-test
 */

import type { DefaultModelsRegistry } from '@wrongstack/core/models';
import type { Config, ProviderConfig } from '@wrongstack/core/types';
import { color, toErrorMessage } from '@wrongstack/core/utils';
import { makeProviderFromConfig, setOAuthTokenPersister } from '@wrongstack/providers';
import { discoverAndMergeProviders } from '../../boot/auto-discover-providers.js';
import { activeProfileConfigPath } from '../../profile-config-path.js';
import {
  mutateConfigProviders,
  normalizeKeys,
  writeKeysBack,
} from '../../provider-config-utils.js';
import type { SubcommandDeps } from '../contracts.js';
import {
  buildModelSmokeTargets,
  type ModelSmokeResult,
  parseModelSmokeOptions,
  runModelSmokeTests,
} from './model-smoke-test.js';
import { fmtMs } from './modeldiag-profiles.js';

export async function runModeldiagTest(
  args: string[],
  deps: SubcommandDeps,
  config: Record<string, unknown>,
): Promise<number> {
  const writeLine = (line = '') => {
    deps.renderer.write(`${line}\n`);
  };

  if (args.slice(1).includes('--help') || deps.flags?.['help'] === true) {
    writeLine(`${color.bold('Usage:')} wstack modeldiag test [options]`);
    writeLine();
    writeLine('  (no flags)              Probe one representative model per configured provider');
    writeLine('  --all-models             Probe every catalog-visible model sequentially');
    writeLine('  --plan                   Show targets without making model calls');
    writeLine('  --provider=<id,...>      Restrict provider ids');
    writeLine('  --model=<id,...>         Restrict model ids');
    writeLine('  --timeout=<ms>           Per-model timeout (default 45000)');
    writeLine('  --max-tokens=<n>         Output cap for the tiny probe (default 32)');
    writeLine('  --json                   Emit machine-readable output');
    writeLine('  --yes                    Confirm a run larger than 50 requests');
    return 0;
  }
  let smokeOptions;
  try {
    smokeOptions = parseModelSmokeOptions(args.slice(1), deps.flags);
  } catch (err) {
    writeLine(`${color.red('Invalid smoke-test options:')} ${toErrorMessage(err)}`);
    return 2;
  }

  if ('mergeOverlay' in deps.modelsRegistry) {
    await discoverAndMergeProviders({
      config: config as unknown as Config,
      registry: deps.modelsRegistry as DefaultModelsRegistry,
      cacheDir: deps.paths.cacheDir,
    });
  }
  const targets = await buildModelSmokeTargets(
    config as unknown as Config,
    deps.modelsRegistry,
    smokeOptions,
  );
  const byProvider = new Map<string, number>();
  for (const target of targets) {
    byProvider.set(target.providerId, (byProvider.get(target.providerId) ?? 0) + 1);
  }

  if (smokeOptions.planOnly) {
    const plan = {
      mode: smokeOptions.allModels ? 'all-models' : 'representative',
      targetCount: targets.length,
      providers: Object.fromEntries(byProvider),
      targets,
    };
    if (smokeOptions.json) {
      writeLine(JSON.stringify(plan, null, 2));
    } else {
      writeLine(`${color.bold('Provider/Model Smoke Test Plan')}`);
      writeLine();
      for (const [providerId, count] of byProvider) {
        writeLine(`  ${color.cyan(providerId.padEnd(24))} ${count} model(s)`);
      }
      writeLine();
      writeLine(
        color.dim(`${targets.length} request(s) would run sequentially. Remove --plan to execute.`),
      );
    }
    return targets.length > 0 ? 0 : 2;
  }

  if (targets.length === 0) {
    const message =
      'No provider/model targets matched. Check the active profile or remove filters.';
    if (smokeOptions.json) {
      writeLine(JSON.stringify({ results: [], summary: { passed: 0, failed: 0 }, error: message }));
    } else {
      writeLine(color.amber(message));
    }
    return 2;
  }

  const confirmed =
    deps.flags?.['yes'] === true ||
    deps.flags?.['yes'] === 'true' ||
    args.slice(1).includes('--yes');
  if (targets.length > 50 && !confirmed) {
    const message = `${targets.length} live requests are planned. Review with --plan, then add --yes to run them.`;
    if (smokeOptions.json) {
      writeLine(JSON.stringify({ error: message, targetCount: targets.length }));
    } else {
      writeLine(color.amber(message));
    }
    return 2;
  }

  if (!smokeOptions.json) {
    writeLine(`${color.bold('Live Provider/Model Smoke Test')}`);
    writeLine(
      color.dim(
        `${targets.length} request(s), sequential, ${smokeOptions.timeoutMs}ms timeout, max ${smokeOptions.maxTokens} output tokens.`,
      ),
    );
    writeLine();
  }

  const resultLines = (result: ModelSmokeResult, index: number, total: number): void => {
    if (smokeOptions.json) return;
    const label = `[${String(index + 1).padStart(String(total).length)}/${total}]`;
    const target = `${result.providerId}/${result.modelId}`;
    if (result.status === 'passed') {
      writeLine(
        `  ${color.green('✓')} ${color.dim(label)} ${color.cyan(target)} ${color.dim(
          `${fmtMs(result.latencyMs)} · in${result.usage.input}/out${result.usage.output} · ${result.stopReason}`,
        )}`,
      );
    } else {
      const status = result.httpStatus ? `HTTP ${result.httpStatus} · ` : '';
      writeLine(
        `  ${color.red('✗')} ${color.dim(label)} ${color.red(target)} ${color.dim(
          `${fmtMs(result.latencyMs)} · ${status}${result.errorKind}`,
        )}`,
      );
      writeLine(`      ${color.red(result.error.slice(0, 240))}`);
    }
  };

  let oauthWriteChain = Promise.resolve();
  let oauthWriteScheduled = false;
  const profilePath = activeProfileConfigPath(deps.paths, config as unknown as Config);
  setOAuthTokenPersister((providerId, credentials) => {
    oauthWriteScheduled = true;
    oauthWriteChain = oauthWriteChain.then(() =>
      mutateConfigProviders(profilePath, deps.vault, (all) => {
        const providerConfig = all[providerId];
        if (!providerConfig) return;
        const keys = normalizeKeys(providerConfig);
        const active = providerConfig.activeKey
          ? keys.find((key) => key.label === providerConfig.activeKey)
          : keys[0];
        if (!active) return;
        active.apiKey = credentials.accessToken;
        active.refreshToken = credentials.refreshToken;
        active.expiresAt = new Date(credentials.expiresAt).toISOString();
        if (credentials.accountId) active.accountId = credentials.accountId;
        writeKeysBack(providerConfig, keys);
      }),
    );
  });

  let results;
  try {
    results = await runModelSmokeTests({
      targets,
      options: smokeOptions,
      createProvider: async (providerId) => {
        const saved = (config.providers as Record<string, ProviderConfig> | undefined)?.[
          providerId
        ];
        const resolved =
          (await deps.modelsRegistry.getProvider(providerId).catch(() => undefined)) ??
          (saved?.type && saved.type !== providerId
            ? await deps.modelsRegistry.getProvider(saved.type).catch(() => undefined)
            : undefined);
        const providerConfig: ProviderConfig = {
          ...(providerId === config.provider
            ? {
                ...(config.apiKey ? { apiKey: config.apiKey as string } : {}),
                ...(config.baseUrl ? { baseUrl: config.baseUrl as string } : {}),
              }
            : {}),
          ...saved,
          type: providerId,
          ...((saved?.family ?? resolved?.family)
            ? { family: saved?.family ?? resolved?.family }
            : {}),
          ...((saved?.baseUrl ?? resolved?.apiBase)
            ? { baseUrl: saved?.baseUrl ?? resolved?.apiBase }
            : {}),
          ...((saved?.envVars ?? resolved?.envVars)
            ? { envVars: saved?.envVars ?? resolved?.envVars }
            : {}),
        };
        return makeProviderFromConfig(providerId, providerConfig);
      },
      onTargetComplete: resultLines,
    });
  } finally {
    setOAuthTokenPersister(undefined);
  }
  let oauthPersistenceError: string | undefined;
  if (oauthWriteScheduled) {
    try {
      await oauthWriteChain;
    } catch (err) {
      oauthPersistenceError = toErrorMessage(err);
    }
  }
  const passed = results.filter((result) => result.status === 'passed').length;
  const failed = results.length - passed;
  const summary = { passed, failed, total: results.length };

  if (smokeOptions.json) {
    writeLine(
      JSON.stringify(
        {
          results,
          summary,
          ...(oauthPersistenceError
            ? {
                warning: `OAuth token refresh worked in-memory but could not be saved: ${oauthPersistenceError}`,
              }
            : {}),
        },
        null,
        2,
      ),
    );
  } else {
    writeLine();
    writeLine(
      `${color.bold('Summary:')} ${color.green(`${passed} passed`)} · ${
        failed > 0 ? color.red(`${failed} failed`) : color.dim('0 failed')
      }`,
    );
    if (!smokeOptions.allModels) {
      writeLine(color.dim('Use --all-models to test every catalog-visible model sequentially.'));
    }
    if (oauthPersistenceError) {
      writeLine(
        color.amber(
          `OAuth token refresh worked in-memory but could not be saved: ${oauthPersistenceError}`,
        ),
      );
    }
  }
  return failed === 0 ? 0 : 1;
}
