/**
 * Boot-time provider + model selection: flags, saved defaults, the first-run
 * credential gate, the "continue with these?" summary and the picker.
 */

import type { Config, ModelsRegistry } from '@wrongstack/contracts/types';
import { color, isStdinTTY, toErrorMessage, writeErr } from '@wrongstack/core/utils';
import { isSetupProvider, SETUP_MODEL_ID, SETUP_PROVIDER_ID } from '@wrongstack/providers';
import { type BootConfigResult, bootConfig } from './boot-config.js';
import {
  autoSelectSavedProvider,
  shouldReuseStartupChoices,
  validateSavedProviderModel,
} from './boot-provider-selection.js';
import type { ReadlineInputReader } from './input-reader.js';
import { type PickerResult, runPicker, saveToGlobalConfig } from './picker.js';
import { hasAnyCredential, runFirstRunSetup } from './pre-launch.js';
import type { TerminalRenderer } from './renderer.js';
import { patchConfig } from './utils.js';

export interface BootProviderInput {
  flags: Record<string, string | boolean>;
  config: Config;
  vault: BootConfigResult['vault'];
  modelsRegistry: ModelsRegistry;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  profileConfigPath: string;
  noInteractiveMode: string | boolean | undefined;
}

export type BootPhaseExit = { kind: 'exit'; code: number };

export async function resolveBootProviderModel(
  input: BootProviderInput,
): Promise<BootPhaseExit | { kind: 'ok'; config: Config; vault: BootConfigResult['vault'] }> {
  let { config, vault } = input;
  const { flags, modelsRegistry, renderer, reader, profileConfigPath, noInteractiveMode } = input;
  const providerFlag = typeof flags['provider'] === 'string' ? flags['provider'] : undefined;
  const modelFlag = typeof flags['model'] === 'string' ? flags['model'] : undefined;
  // Non-interactive surfaces can't run the picker, so adopt a saved provider
  // (e.g. a custom one added via /auth) when the active pointers are unset —
  // otherwise a custom-provider-only config fails the presence check below and
  // shows "No provider or model configured". The TUI reaches the picker instead.
  if (noInteractiveMode && (!config.provider || !config.model)) {
    // Explicit --provider/--model flags surface into the live config so --webui
    // boots into the ready state instead of the setup screen. Combined with the
    // `if (!(!!providerFlag && !!modelFlag))` gate below skipping registry
    // validation entirely in non-interactive mode, callers (notably CI E2E)
    // can provide any id pair to skip the auth gate — downstream provider
    // resolution is still typed, just unvalidated at boot.
    if (providerFlag && modelFlag) {
      config = patchConfig(config, { provider: providerFlag, model: modelFlag });
    } else {
      const picked = await autoSelectSavedProvider(config, modelsRegistry);
      if (picked) config = patchConfig(config, picked);
    }
  }
  if (!(!!providerFlag && !!modelFlag)) {
    if (isStdinTTY() && !noInteractiveMode) {
      let picked: PickerResult | undefined;
      let skipPicker = false;

      // --- First-run gate: nothing on this machine can reach a model ---
      // Runs BEFORE the picker. The picker lists the ~190-entry models.dev
      // catalog, none of which is usable without a credential, and cancelling
      // it exits the process — so a newcomer could never reach the TUI to run
      // `/auth`. This gate offers the four real ways in plus setup mode, so
      // there is always a path that ends inside the app.
      if (isSetupProvider(config.provider)) {
        // Already opted into setup mode on an earlier launch. Re-showing the
        // welcome screen every time would nag; a one-line reminder plus the
        // `/auth` pointer is enough, and adding a credential retires this
        // state on its own.
        skipPicker = true;
        renderer.write(
          `\n  ${color.amber('▶')} ${color.bold('Setup mode')} ${color.dim('— no model connected. Run')} ${color.bold('/auth')} ${color.dim('to connect one.')}\n\n`,
        );
      } else if (!(await hasAnyCredential(config, modelsRegistry))) {
        const outcome = await runFirstRunSetup({
          renderer,
          reader,
          modelsRegistry,
          vault,
          profileConfigPath,
          reloadConfig: async () => (await bootConfig(flags)).config,
        });
        if (outcome.kind === 'quit') {
          await reader.close();
          return { kind: 'exit' as const, code: 0 };
        }
        if (outcome.kind === 'setup-mode') {
          config = patchConfig(config, { provider: SETUP_PROVIDER_ID, model: SETUP_MODEL_ID });
          // Persist so a relaunch goes straight back in rather than re-asking.
          // Only the top-level pointers are written — never a `providers[]`
          // entry — which is what makes the first real credential retire setup
          // mode automatically (see clearStaleProviderDefaults).
          await saveToGlobalConfig(profileConfigPath, SETUP_PROVIDER_ID, SETUP_MODEL_ID);
          skipPicker = true;
        } else {
          // Credentials landed on disk; our in-memory copy is stale. Re-read it
          // the same way the backup-restore path above does, then fall through
          // to the normal picker — which now has something real to offer.
          try {
            const reloaded = await bootConfig(flags);
            config = reloaded.config;
            vault = reloaded.vault;
          } catch (err) {
            writeErr(`Config error after setup: ${toErrorMessage(err)}\n`);
            await reader.close();
            return { kind: 'exit' as const, code: 2 };
          }
        }
      }

      // --- Summary gate: saved provider/model from last session ---
      // Skipped when the first-run gate above already decided the surface —
      // otherwise setup mode would be announced twice and then re-confirmed.
      const savedProvider = config.provider;
      const savedModel = config.model;
      if (!skipPicker && savedProvider && savedModel) {
        const savedStatus = await validateSavedProviderModel(config, modelsRegistry);
        renderer.write(
          `\n  ${color.dim('Last settings:')} ${color.bold(savedProvider)} / ${color.bold(savedModel)}\n`,
        );
        if (!savedStatus.ok) {
          renderer.writeWarning(
            `Saved provider/model is no longer usable (${savedStatus.reason ?? 'unknown reason'}); choose a provider.\n`,
          );
        } else if (shouldReuseStartupChoices(config)) {
          // "Reuse startup choices" is on and the saved pair is still usable:
          // take it without the Continue question.
          skipPicker = true;
          renderer.write(
            `\n  ${color.green('▶')} ${color.bold(savedProvider)} / ${color.bold(savedModel)}\n\n`,
          );
        } else {
          const answer = (
            await reader.readLine(
              `  ${color.amber('?')} Continue with these? ${color.dim('[Y/n/q]')} ${color.dim('(auto Y in 5s)')} `,
              { timeoutMs: 5000, defaultAnswer: 'y' },
            )
          )
            .trim()
            .toLowerCase();
          if (answer === 'q') {
            renderer.write(color.dim('  Goodbye!\n'));
            await reader.close();
            return { kind: 'exit' as const, code: 0 };
          }
          if (answer !== 'n' && answer !== 'no') {
            // Accepted — use saved values, skip the picker entirely
            skipPicker = true;
            renderer.write(
              `\n  ${color.green('▶')} ${color.bold(savedProvider)} / ${color.bold(savedModel)}\n\n`,
            );
          }
        }
      }

      if (!skipPicker) {
        picked = await runPicker({
          modelsRegistry,
          renderer,
          reader,
          config,
          defaultProvider: providerFlag ?? config.provider,
          defaultModel: modelFlag ?? config.model,
        });
      }

      if (!picked && !skipPicker) {
        if (!config.provider || !config.model) {
          // Cancelling the picker used to exit 2 with nothing printed, which
          // reads as a crash. Say what happened and name both ways forward.
          renderer.write(
            `\n  ${color.dim('No provider selected.')}\n` +
              `  ${color.dim('Run')} ${color.bold('wstack auth')} ${color.dim('to add a key or sign in, or start with no model:')}\n` +
              `  ${color.bold(`wstack --provider ${SETUP_PROVIDER_ID} --model ${SETUP_MODEL_ID}`)}\n\n`,
          );
          await reader.close();
          return { kind: 'exit' as const, code: 2 };
        }
      }

      if (picked) {
        const prevProvider = config.provider;
        const prevModel = config.model;
        const prevEffort = config.modelRuntime?.reasoning?.effort;
        config = patchConfig(config, {
          provider: picked.provider,
          model: picked.model,
          ...(picked.effort
            ? {
                modelRuntime: {
                  ...config.modelRuntime,
                  reasoning: { ...config.modelRuntime?.reasoning, effort: picked.effort },
                },
              }
            : {}),
        });
        const effortChanged = picked.effort !== undefined && picked.effort !== prevEffort;
        if (picked.provider !== prevProvider || picked.model !== prevModel || effortChanged) {
          const label = `${picked.provider}/${picked.model}${picked.effort ? ` (effort ${picked.effort})` : ''}`;
          const saved = await saveToGlobalConfig(profileConfigPath, picked.provider, picked.model, {
            effort: picked.effort,
          });
          if (saved) {
            renderer.writeInfo(`Saved ${label} as default.\n`);
          } else {
            renderer.writeWarning(
              `Could not save ${label} to config. Check permissions or disk space.\n`,
            );
          }
        }
      }
    } else if (!config.provider || !config.model) {
      writeErr(
        'No provider or model configured. Run `wstack auth`, or pass --provider <id> --model <id>.\n' +
          `To start the app with no model connected, pass --provider ${SETUP_PROVIDER_ID} --model ${SETUP_MODEL_ID}.\n`,
      );
      await reader.close();
      return { kind: 'exit' as const, code: 2 };
    } else {
      const savedStatus = await validateSavedProviderModel(config, modelsRegistry);
      if (!savedStatus.ok) {
        writeErr(
          `Saved provider/model is no longer usable (${savedStatus.reason ?? 'unknown reason'}). Run \`wstack auth\` or pass --provider <id> --model <id>.\n`,
        );
        await reader.close();
        return { kind: 'exit' as const, code: 2 };
      }
    }
  }
  return { kind: 'ok', config, vault };
}
