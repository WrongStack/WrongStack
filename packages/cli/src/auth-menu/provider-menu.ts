import type { ProviderConfig } from '@wrongstack/core/types';
import { color, expectDefined } from '@wrongstack/core/utils';
import {
  maskedKey,
  mutateConfigProviders,
  normalizeKeys,
  nowIso,
  writeKeysBack,
} from '../provider-config-utils.js';
import { addKeyForProvider } from './add-provider.js';
import { loadProviders } from './helpers.js';
import {
  confirm,
  readKeyInput,
  renderActions,
  renderProviderHeader,
  validateFamily,
} from './shared.js';
import type { AuthMenuDeps } from './types.js';

/**
 * Interactive submenu for managing a single provider's keys and settings.
 * Loops until the user goes back or quits.
 */
export async function manageProvider(providerId: string, deps: AuthMenuDeps): Promise<void> {
  for (;;) {
    const providers = await loadProviders(deps);
    const cfg = providers[providerId];
    if (!cfg) {
      deps.renderer.writeError(`Provider "${providerId}" no longer in config.`);
      return;
    }
    const keys = normalizeKeys(cfg);

    renderProviderHeader(deps.renderer, providerId, cfg);
    renderActions(deps.renderer, keys.length);

    const raw = (await deps.reader.readLine(`\n${color.amber('?')} ${providerId} > `)).trim();

    if (!raw || raw === 'b' || raw === 'back' || raw === 'q' || raw === 'quit') {
      return;
    }

    const [verb = '', argRaw = ''] = raw.split(/\s+/, 2);
    const arg = argRaw ? Number.parseInt(argRaw, 10) : Number.NaN;

    const handled = await dispatchAction(verb, arg, providerId, keys, cfg, deps);
    if (handled === 'exit') return;
    if (handled === 'continue') continue;
    // Unknown command — error message already printed
  }
}

type ActionResult = 'continue' | 'exit' | 'unknown' | void;

async function dispatchAction(
  verb: string,
  arg: number,
  providerId: string,
  keys: ReturnType<typeof normalizeKeys>,
  cfg: ProviderConfig,
  deps: AuthMenuDeps,
): Promise<ActionResult> {
  // --- Add another key ---
  if (verb === 'a' || verb === 'add') {
    await addKeyForProvider(providerId, deps, cfg);
    return 'continue';
  }

  // --- Remove provider ---
  if (verb === 'x' || verb === 'remove') {
    const answer = await confirm(
      deps,
      `Remove provider "${providerId}" and ${keys.length} key(s)?`,
    );
    if (answer === null) return 'continue'; // cancelled
    if (answer) {
      await mutateConfigProviders(
        deps.profileConfigPath,
        deps.vault,
        (all) => {
          delete all[providerId];
        },
        deps.profileConfigPath,
      );
      deps.renderer.write(`  ${color.green('✓')} Removed ${providerId}.\n`);
      return 'exit';
    }
    return 'continue';
  }

  // --- Update key ---
  if (verb === 'u' || verb === 'update') {
    if (!validKeyIndex(arg, keys.length, deps, 'u')) return 'continue';
    const target = expectDefined(keys[arg - 1]);
    const newKey = await readKeyInput(deps, `New key for ${target.label}`);
    if (!newKey) return 'continue';
    await mutateConfigProviders(
      deps.profileConfigPath,
      deps.vault,
      (all) => {
        const p = all[providerId];
        if (!p) return;
        const list = normalizeKeys(p).map((k) =>
          k.label === target.label ? { ...k, apiKey: newKey, createdAt: nowIso() } : k,
        );
        writeKeysBack(p, list);
      },
      deps.profileConfigPath,
    );
    deps.renderer.write(`  ${color.green('✓')} Updated ${providerId}/${target.label}.\n`);
    return 'continue';
  }

  // --- Delete key ---
  if (verb === 'd' || verb === 'delete' || verb === 'rm') {
    if (!validKeyIndex(arg, keys.length, deps, 'd')) return 'continue';
    const target = expectDefined(keys[arg - 1]);
    const answer = await confirm(
      deps,
      `Delete key "${target.label}" (${maskedKey(target.apiKey)})?`,
    );
    if (answer === null) return 'continue'; // cancelled
    if (!answer) return 'continue'; // declined
    await mutateConfigProviders(
      deps.profileConfigPath,
      deps.vault,
      (all) => {
        const p = all[providerId];
        if (!p) return;
        const list = normalizeKeys(p).filter((k) => k.label !== target.label);
        writeKeysBack(p, list);
        if (p.activeKey === target.label) {
          p.activeKey = list[0]?.label;
        }
      },
      deps.profileConfigPath,
    );
    deps.renderer.write(`  ${color.green('✓')} Deleted ${providerId}/${target.label}.\n`);
    return 'continue';
  }

  // --- Set active key ---
  if (verb === 's' || verb === 'set' || verb === 'active') {
    if (!validKeyIndex(arg, keys.length, deps, 's')) return 'continue';
    const target = expectDefined(keys[arg - 1]);
    await mutateConfigProviders(
      deps.profileConfigPath,
      deps.vault,
      (all) => {
        const p = all[providerId];
        if (!p) return;
        const list = normalizeKeys(p);
        writeKeysBack(p, list);
        p.activeKey = target.label;
      },
      deps.profileConfigPath,
    );
    deps.renderer.write(`  ${color.green('✓')} Active key → ${color.bold(target.label)}.\n`);
    return 'continue';
  }

  // --- Edit family ---
  if (verb === 'f' || verb === 'family') {
    const current = cfg.family ?? '';
    const ans = (
      await deps.reader.readLine(
        `  ${color.amber('?')} Family ${color.dim(`(anthropic | openai | openai-compatible | google, empty = unset, current: ${current || 'unset'})`)}: `,
      )
    ).trim();
    if (ans !== '') {
      const validated = validateFamily(ans);
      if (!validated) {
        deps.renderer.writeError(
          `Invalid family: "${ans}". Must be one of: anthropic, openai, openai-compatible, google.`,
        );
        return 'continue';
      }
      await mutateConfigProviders(
        deps.profileConfigPath,
        deps.vault,
        (all) => {
          const p = all[providerId];
          if (!p) return;
          p.family = validated;
        },
        deps.profileConfigPath,
      );
      deps.renderer.write(`  ${color.green('✓')} family → ${validated}\n`);
    } else {
      await mutateConfigProviders(
        deps.profileConfigPath,
        deps.vault,
        (all) => {
          const p = all[providerId];
          if (!p) return;
          delete p.family;
        },
        deps.profileConfigPath,
      );
      deps.renderer.write(`  ${color.green('✓')} family → (unset)\n`);
    }
    return 'continue';
  }

  // --- Edit baseUrl ---
  // `B` is capitalised because bare `b` is "back" — accept the spelled-out
  // forms too so a user who types `b`, sees the menu close, and reaches for
  // the obvious word doesn't have to guess the shift key.
  if (verb === 'B' || verb === 'baseurl' || verb === 'base-url' || verb === 'url') {
    const current = cfg.baseUrl ?? '';
    const ans = (
      await deps.reader.readLine(
        `  ${color.amber('?')} Base URL ${color.dim(`(empty = unset, current: ${current || 'unset'})`)}: `,
      )
    ).trim();
    await mutateConfigProviders(
      deps.profileConfigPath,
      deps.vault,
      (all) => {
        const p = all[providerId];
        if (!p) return;
        if (ans === '') delete p.baseUrl;
        else p.baseUrl = ans;
      },
      deps.profileConfigPath,
    );
    deps.renderer.write(`  ${color.green('✓')} baseUrl → ${ans || '(unset)'}\n`);
    return 'continue';
  }

  // --- Edit models ---
  if (verb === 'm' || verb === 'models') {
    const current = (cfg.models ?? []).join(', ');
    const ans = (
      await deps.reader.readLine(
        `  ${color.amber('?')} Model ids ${color.dim(`(comma-separated, empty = catalog default, current: ${current || 'none'})`)}: `,
      )
    ).trim();
    const list = ans
      ? ans
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    await mutateConfigProviders(
      deps.profileConfigPath,
      deps.vault,
      (all) => {
        const p = all[providerId];
        if (!p) return;
        if (list.length === 0) delete p.models;
        else p.models = list;
      },
      deps.profileConfigPath,
    );
    deps.renderer.write(
      `  ${color.green('✓')} models → ${list.length === 0 ? '(catalog default)' : list.join(', ')}\n`,
    );
    return 'continue';
  }

  // --- Unknown ---
  deps.renderer.writeError(`Unknown action: "${verb}". Type b for back or q to quit.`);
  return 'unknown';
}

function validKeyIndex(
  arg: number,
  max: number,
  deps: { renderer: AuthMenuDeps['renderer'] },
  verb: string,
): boolean {
  if (!Number.isFinite(arg) || arg < 1 || arg > max) {
    deps.renderer.writeError(`Usage: ${verb} <1-${max}>`);
    return false;
  }
  return true;
}
