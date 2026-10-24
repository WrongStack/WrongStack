import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config, ModelsRegistry } from '@wrongstack/contracts/types';
import {
  color,
  moduleUrlFor,
  toErrorMessage,
  wrongstackPackageJsonPath,
} from '@wrongstack/core/utils';
import { isSetupProvider } from '@wrongstack/providers';
import { ACP_LEADER_PROVIDER_ID } from './acp-leader/acp-leader-host.js';
import { WRONGFORGE_AGENT_ID } from './fleet/wrongforge-client.js';

import type { ReadlineInputReader } from './input-reader.js';

import { resolveActiveApiKey } from './provider-config-utils.js';

import { isKeylessLocalProvider, visibleModelIds } from './provider-helpers.js';

import type { TerminalRenderer } from './renderer.js';

/**
 * Resolve the bundled overlay `providers.json`. It ships at `<pkg>/data/` —
 * a sibling of both `src/` (dev) and `dist/` (published) — so `../data/…`
 * relative to this module resolves in both. Returns undefined if anything
 * about the resolution looks off (the overlay is optional).
 */
export function resolveBundledOverlayFile(): string | undefined {
  try {
    return fileURLToPath(
      new URL('../data/providers.json', moduleUrlFor(import.meta.url, '@wrongstack/cli')),
    );
  } catch {
    return undefined;
  }
}

export interface SavedDefaultStatus {
  ok: boolean;
  reason?: string;
}

export async function validateSavedProviderModel(
  config: Config,
  modelsRegistry: ModelsRegistry,
): Promise<SavedDefaultStatus> {
  const providerId = config.provider;
  const modelId = config.model;
  if (!providerId || !modelId) return { ok: false, reason: 'missing provider/model' };

  // Setup mode is always usable by construction: no catalog entry, no saved
  // config entry, no credential. Every check below would (correctly) reject
  // it, so answer here instead of teaching each one about it.
  if (isSetupProvider(providerId)) return { ok: true };
  // An ACP agent as the leader: no catalog entry and no key — the agent signs
  // itself in. A missing agent surfaces on the first turn, by name.
  if (providerId === ACP_LEADER_PROVIDER_ID) return { ok: true };
  // WrongForge as the leader: no catalog entry, its own key file. An unserved
  // model or a stopped server surfaces on the first turn, by name.
  if (providerId === WRONGFORGE_AGENT_ID) return { ok: true };

  const saved = config.providers?.[providerId];
  const lookupId = saved?.type && saved.type !== providerId ? saved.type : providerId;
  const catalogProvider = await modelsRegistry.getProvider(lookupId).catch(() => undefined);
  if (!catalogProvider && !saved?.family)
    return { ok: false, reason: `provider "${providerId}" is no longer available` };

  const hasCredential =
    (catalogProvider?.envVars ?? saved?.envVars ?? []).some((envVar) =>
      Boolean(process.env[envVar]),
    ) ||
    (saved !== undefined && resolveActiveApiKey(saved) !== undefined) ||
    isKeylessLocalProvider({
      apiBase: saved?.baseUrl ?? catalogProvider?.apiBase,
      envVars: saved?.envVars ?? catalogProvider?.envVars,
    });
  if (!hasCredential) return { ok: false, reason: `provider "${providerId}" has no usable key` };

  const visible = visibleModelIds(
    providerId,
    config,
    (catalogProvider?.models ?? []).map((m) => m.id),
    saved,
  );
  if (visible.length > 0 && !visible.includes(modelId)) {
    return {
      ok: false,
      reason: `model "${modelId}" is no longer available for provider "${providerId}"`,
    };
  }
  return { ok: true };
}

/**
 * Resolve a usable `{ provider, model }` from saved config when the active
 * pointers are unset — the non-interactive (WebUI / --no-interactive) analogue
 * of the TUI's interactive picker. Mirrors the standalone WebUI's auto-select
 * (packages/webui-server start-webui.ts) so a config whose only entry is a
 * custom provider still boots instead of erroring out. Prefers an already-set
 * `config.provider`, otherwise the first saved provider; the model comes from
 * the provider's saved `models` allowlist, falling back to the catalog's first
 * model. Returns undefined when no provider yields a concrete model.
 */
export async function autoSelectSavedProvider(
  config: Config,
  modelsRegistry: ModelsRegistry,
): Promise<{ provider: string; model: string } | undefined> {
  const providers = config.providers ?? {};
  const entries =
    config.provider && providers[config.provider]
      ? ([[config.provider, providers[config.provider]]] as const)
      : Object.entries(providers);
  for (const [id, cfg] of entries) {
    if (!cfg) continue;
    let model = cfg.models?.[0];
    if (!model) {
      const catalogId = cfg.type && cfg.type !== id ? cfg.type : id;
      const catalog = await modelsRegistry.getProvider(catalogId).catch(() => undefined);
      model = catalog?.models?.[0]?.id;
    }
    if (model) return { provider: id, model };
  }
  return undefined;
}

export function resolveBundledSkillsDir(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const corePkg = wrongstackPackageJsonPath('@wrongstack/core', (id) => req.resolve(id));
    return path.join(path.dirname(corePkg), 'skills');
  } catch {
    return undefined;
  }
}

export function resolveBundledPromptsDir(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const corePkg = wrongstackPackageJsonPath('@wrongstack/core', (id) => req.resolve(id));
    return path.join(path.dirname(corePkg), 'data', 'prompts');
  } catch {
    return undefined;
  }
}

/**
 * Determine whether a directory is the user's home directory. Used by the
 * startup guard to refuse launching wstack in `~` — where it would risk
 * creating a `.git` repo at the top of the user's filesystem.
 *
 * Resolves both paths so trailing slashes and relative segments are
 * normalized before the comparison. Case is compared as-is (matches
 * `os.homedir()` and `process.cwd()` output on every platform). Symlinks
 * are NOT followed: the common case (`cwd === os.homedir()` literally) is
 * what this guard targets.
 *
 * Exported for testing — the call site in {@link boot} performs the actual
 * warning + exit.
 */
export function isHomeDirectory(cwd: string, userHome: string): boolean {
  if (!cwd || !userHome) return false;
  return path.resolve(cwd) === path.resolve(userHome);
}

/**
 * `launch.rememberStartupChoices` (TUI Settings → "Reuse startup choices"):
 * when on, the boot gates reuse the saved provider/model, system-prompt
 * variant and mode/YOLO/autonomy without asking "Continue with these?".
 * Unset means on; only an explicit `false` brings the questions back.
 */
export function shouldReuseStartupChoices(config: Pick<Config, 'launch'>): boolean {
  return config.launch?.rememberStartupChoices !== false;
}

/** One dim line telling the user how to get the startup questions back. */
export const REUSE_STARTUP_CHOICES_HINT = '(ask every launch: /settings reuse-startup-choices off)';

/**
 * Determine whether the first-run YOLO disclosure notice should be printed
 * to stderr. Exported for testing.
 *
 * @param lastChoices  Saved launch preferences from config (undefined = first run)
 * @param yoloPinned   Explicit --yolo/--no-yolo flag (undefined = not provided)
 * @param yolo         Resolved YOLO state
 */
export function shouldPrintYoloNotice(
  lastChoices: unknown,
  yoloPinned: boolean | undefined,
  yolo: boolean,
): boolean {
  return !lastChoices && yoloPinned === undefined && yolo;
}

/**
 * Check whether the current working directory has a `.git` repository.
 * If not, prompt the user before the path resolver walks up to a parent.
 * When the parent directory contains a `.git`, also inform the user so
 * they know why the project root was resolved to a different directory.
 */
export async function checkGitInCwd(opts: {
  cwd: string;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
}): Promise<void> {
  const { cwd, renderer, reader } = opts;
  const cwdGit = path.join(cwd, '.git');

  let hasCwdGit = false;
  try {
    await fs.access(cwdGit);
    hasCwdGit = true;
  } catch {
    // no .git in cwd
  }

  if (!hasCwdGit) {
    renderer.write(
      `\n  ${color.amber('○')} This folder has no ${color.bold('.git')} repository.\n`,
    );
    const answer = (
      await reader.readLine(`  ${color.amber('?')} Initialize one here? ${color.dim('[y/N]')} `)
    )
      .trim()
      .toLowerCase();
    if (answer === 'y' || answer === 'yes') {
      try {
        const { spawn } = await import('node:child_process');
        await new Promise<void>((resolve, reject) => {
          const child = spawn('git', ['init'], {
            cwd,
            signal: AbortSignal.timeout(10_000),
            windowsHide: true,
          });
          child.on('error', reject);
          child.on('close', (code) =>
            code === 0 ? resolve() : reject(new Error(`git init failed with ${code}`)),
          );
        });
        renderer.write(`  ${color.green('✓')} Git repository initialized\n`);
        hasCwdGit = true;
      } catch (err) {
        renderer.writeError(`git init failed: ${toErrorMessage(err)}\n`);
      }
    }
  }

  // Check only the immediate parent — inform the user if .git exists there.
  const parentDir = path.dirname(cwd);
  if (parentDir !== cwd) {
    try {
      await fs.access(path.join(parentDir, '.git'));
      renderer.write(
        `  ${color.dim('ℹ')} A ${color.bold('.git')} repo exists in the parent directory: ${color.dim(parentDir)}\n`,
      );
    } catch {
      // parent has no .git — nothing to report
    }
  }
}
