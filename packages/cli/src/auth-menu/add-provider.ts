import * as fs from 'node:fs/promises';
import type { ProviderConfig, ResolvedProvider, WireFamily } from '@wrongstack/core/types';
import { atomicWrite, color } from '@wrongstack/core/utils';
import { catalogProviderIdFor, PROVIDER_DEFINITIONS } from '@wrongstack/providers';
import { runLiveProviderPicker } from '../picker.js';
import {
  mutateConfigProviders,
  normalizeKeys,
  nowIso,
  writeKeysBack,
} from '../provider-config-utils.js';
import { nextCustomProviderId } from '../provider-id.js';
import { loadProviders } from './helpers.js';
import { renderOAuthLoginOptions, runOAuthLoginChoice } from './oauth-menu.js';
import { readKeyInput, suggestLabel, validateFamily } from './shared.js';
import type { AuthMenuDeps } from './types.js';

/* ------------------------------------------------------------------ */
/*  Add from catalog — pick a known provider from models.dev            */
/* ------------------------------------------------------------------ */

/**
 * Providers WrongStack defines itself but models.dev does not list under that
 * id — the AI Gateway, which models.dev files as `vercel`. Without this they
 * are unreachable from the catalog picker and the user has to hand-roll a
 * custom entry to use them.
 */
export function ownDefinitionsAsCatalog(known: Set<string>): ResolvedProvider[] {
  return Object.values(PROVIDER_DEFINITIONS)
    .filter((d) => !known.has(d.id) && d.family !== 'unsupported' && d.usage !== 'local')
    .map((d) => ({
      id: d.id,
      name: d.name,
      family: d.family,
      envVars: [...d.envVars],
      models: [],
      // `discoveryOnlyBaseUrl` definitions keep their model-list URL out of the
      // Base URL prompt: offering it as a default persists it as the provider's
      // wire base, which is a different endpoint (see the AI Gateway entry).
      ...(d.baseUrl && !d.discoveryOnlyBaseUrl ? { apiBase: d.baseUrl } : {}),
      ...(d.docsUrl ? { doc: d.docsUrl } : {}),
    }));
}

export async function addFromCatalog(deps: AuthMenuDeps): Promise<boolean> {
  let catalog: ResolvedProvider[] = [];
  try {
    catalog = (await deps.modelsRegistry.listProviders()).filter((p) => p.family !== 'unsupported');
  } catch {
    deps.renderer.writeWarning('Catalog unavailable — falling back to manual entry.\n');
  }

  if (catalog.length === 0) {
    // An unreachable catalog still means manual entry — augmenting an EMPTY
    // list would silently retire that fallback.
    return addManualEntry(deps);
  }
  catalog = [...catalog, ...ownDefinitionsAsCatalog(new Set(catalog.map((p) => p.id)))];

  const saved = new Set(Object.keys(await loadProviders(deps)));
  deps.renderer.write(
    color.dim(
      `  Catalog: ${catalog.length} providers. Type to filter, ↑/↓ navigate, Enter to select.\n`,
    ),
  );
  deps.renderer.write(`  ${color.dim('◉ already saved   ○ no key yet')}\n\n`);
  renderOAuthLoginOptions(deps);
  deps.renderer.write('\n');

  const chosen = await runLiveProviderPicker(catalog, saved);
  if (!chosen) {
    // User cancelled — offer OAuth as an alternative.
    deps.renderer.write(
      `\n  ${color.dim('OAuth login options:')} ${color.dim('chatgpt')}, ${color.dim('claude')}, or ${color.dim('copilot')}?\n`,
    );
    const answer = (
      await deps.reader.readLine(
        `  ${color.amber('?')} OAuth or q to quit ${color.dim('[chatgpt/claude/copilot]')}: `,
      )
    ).trim();
    if (answer && (await runOAuthLoginChoice(deps, answer, { allowNumeric: false }))) {
      return true;
    }
    return false;
  }

  return addKeyForCatalogProvider(deps, chosen);
}

/**
 * Prompt for family/baseUrl/alias overrides, then add a key.
 * Returns true if a key was added.
 *
 * Exported for the TUI auth panel: the panel does its own catalog
 * selection (searchable list) and then drives this flow through the
 * prompt bridge for the override/label/key questions.
 */
export async function addKeyForCatalogProvider(
  deps: AuthMenuDeps,
  chosen: ResolvedProvider,
): Promise<boolean> {
  deps.renderer.write(
    color.dim(`\n  Defaults from models.dev — press Enter to keep, or type overrides.\n`),
  );

  // Family override
  const famRaw = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Family ${color.dim(`[${chosen.family}]`)} ${color.dim('(q to quit)')}: `,
    )
  ).trim();
  if (famRaw === 'q') return false;
  let family: WireFamily = chosen.family as WireFamily;
  if (famRaw) {
    const validated = validateFamily(famRaw);
    if (!validated) {
      deps.renderer.writeError(
        `Invalid family: "${famRaw}" (must be: anthropic, openai, openai-compatible, google).`,
      );
      return false;
    }
    family = validated;
  }

  // Base URL override
  const baseRaw = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Base URL ${color.dim(`[${chosen.apiBase ?? 'unset'}]`)} ${color.dim('(q to quit)')}: `,
    )
  ).trim();
  if (baseRaw === 'q') return false;
  const baseUrl: string | undefined = baseRaw || chosen.apiBase;

  // Alias
  const providersNow = await loadProviders(deps);
  let suggestedAlias = chosen.id;
  if (family !== (chosen.family as WireFamily)) {
    let candidate = `${chosen.id}-${family}`;
    let n = 2;
    while (providersNow[candidate]) {
      candidate = `${chosen.id}-${family}-${n}`;
      n++;
    }
    suggestedAlias = candidate;
  }
  const aliasRaw = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Save as alias ${color.dim(`[${suggestedAlias}]`)} ${color.dim('(used with --provider <alias>)')}: `,
    )
  ).trim();
  const alias = aliasRaw || suggestedAlias;

  // Check for conflicting existing entry
  const existing = providersNow[alias];
  if (existing) {
    const sameFamily = (existing.family ?? (chosen.family as WireFamily)) === family;
    const sameBase = (existing.baseUrl ?? chosen.apiBase) === baseUrl;
    if (!sameFamily || !sameBase) {
      deps.renderer.writeError(
        `Alias "${alias}" already exists with different family/baseUrl.\n  ` +
          `Existing: family=${existing.family ?? '(unset)'}, baseUrl=${existing.baseUrl ?? '(unset)'}\n  ` +
          `New:      family=${family}, baseUrl=${baseUrl ?? '(unset)'}\n  ` +
          `Pick a different alias to keep them separate.`,
      );
      return false;
    }
  }

  return addKeyForProvider(alias, deps, {
    type: chosen.id,
    family,
    baseUrl,
    envVars: chosen.envVars,
  });
}

/* ------------------------------------------------------------------ */
/*  Add custom provider — fully user-defined (bypasses catalog)        */
/* ------------------------------------------------------------------ */

export async function addCustomProvider(deps: AuthMenuDeps): Promise<boolean> {
  deps.renderer.write(
    `\n${color.bold('Custom provider')} ${color.dim('— for local models or proxies not in the catalog.')}\n`,
  );

  const providersNow = await loadProviders(deps);
  const idRaw = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Provider id ${color.dim('(e.g. "local-llama", "my-proxy"; blank = auto custom-N, q to quit)')}: `,
    )
  ).trim();
  if (idRaw === 'q') return false;

  let type = idRaw;
  if (!type) {
    // Blank id → assign a non-colliding custom-N name instead of rejecting,
    // so a hastily-added provider still gets a stable, unique id that won't
    // clash with (or overwrite) another entry.
    type = nextCustomProviderId(Object.keys(providersNow));
    deps.renderer.write(`  ${color.dim('Using generated id:')} ${color.bold(type)}\n`);
  } else if (providersNow[type]) {
    deps.renderer.writeWarning(`"${type}" already exists. Pick it from the main menu to edit.`);
    return false;
  }

  const familyRaw = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Wire family ${color.dim('(anthropic | openai | openai-compatible | google)')} ${color.dim('(q to quit)')}: `,
    )
  ).trim();
  if (familyRaw === 'q') return false;
  const family = validateFamily(familyRaw);
  if (!family) {
    deps.renderer.writeError(`Invalid family: "${familyRaw}"`);
    return false;
  }

  const baseUrl = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Base URL ${color.dim('(e.g. http://localhost:11434/v1, optional)')}: `,
    )
  ).trim();

  const modelsRaw = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Model ids ${color.dim('(comma-separated, optional)')}: `,
    )
  ).trim();
  const models = modelsRaw
    ? modelsRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const envVarsRaw = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Env var names ${color.dim('(comma-separated, optional)')}: `,
    )
  ).trim();
  const envVars = envVarsRaw
    ? envVarsRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  return addKeyForProvider(type, deps, {
    type,
    family,
    ...(baseUrl ? { baseUrl } : {}),
    ...(models ? { models } : {}),
    ...(envVars ? { envVars } : {}),
  });
}

/* ------------------------------------------------------------------ */
/*  Manual entry — fallback when catalog is unavailable                */
/* ------------------------------------------------------------------ */

async function addManualEntry(deps: AuthMenuDeps): Promise<boolean> {
  const pid = (
    await deps.reader.readLine(`  ${color.amber('?')} Provider id ${color.dim('[q to quit]')}: `)
  ).trim();
  if (!pid || pid === 'q') return false;

  const famRaw = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Family ${color.dim('(anthropic/openai/openai-compatible/google)')}: `,
    )
  ).trim();
  const family = validateFamily(famRaw);
  if (!family) {
    deps.renderer.writeError(`Invalid family: "${famRaw}"`);
    return false;
  }

  const baseUrl = (
    await deps.reader.readLine(`  ${color.amber('?')} Base URL ${color.dim('(optional)')}: `)
  ).trim();

  return addKeyForProvider(pid, deps, {
    type: pid,
    family,
    ...(baseUrl ? { baseUrl } : {}),
  });
}

/* ------------------------------------------------------------------ */
/*  Core: add a key to a provider                                     */
/* ------------------------------------------------------------------ */

export async function addKeyForProvider(
  providerId: string,
  deps: AuthMenuDeps,
  template: Partial<ProviderConfig>,
): Promise<boolean> {
  const providers = await loadProviders(deps);
  const existing = providers[providerId];
  const existingKeys = existing ? normalizeKeys(existing) : [];
  const usedLabels = new Set(existingKeys.map((k) => k.label));

  const label = await promptForLabel(deps, usedLabels);
  if (!label) return false;

  const apiKey = await readKeyInput(deps, `API key for ${providerId}/${label}`);
  if (!apiKey) return false;

  await mutateConfigProviders(
    deps.profileConfigPath,
    deps.vault,
    (all) => {
      const existingProv: ProviderConfig = all[providerId] ?? {
        type: providerId,
        ...template,
      };
      if (!existingProv.type) existingProv.type = providerId;
      if (!existingProv.family && template.family) {
        existingProv.family = template.family;
      }
      if (!existingProv.baseUrl && template.baseUrl) {
        existingProv.baseUrl = template.baseUrl;
      }
      if (!existingProv.envVars && template.envVars) {
        existingProv.envVars = template.envVars;
      }
      const list = normalizeKeys(existingProv);
      list.push({ label, apiKey, createdAt: nowIso() });
      writeKeysBack(existingProv, list);
      if (!existingProv.activeKey) existingProv.activeKey = label;
      all[providerId] = existingProv;
    },
    deps.profileConfigPath,
  );

  deps.renderer.write(
    `  ${color.green('✓')} Saved ${color.bold(providerId)}/${color.bold(label)}.\n`,
  );
  deps.renderer.write(color.dim(`  Launch: wstack --provider ${providerId} "<task>"\n`));

  // If the user has no active default yet, adopt this provider as the default
  // so the very first provider they add is immediately usable — the WebUI
  // otherwise shows a "no model / needs setup" screen when config.provider or
  // config.model is unset (the TUI tolerates it via its own picker). Never
  // overrides an existing default; best-effort so a miss just defers the pick.
  try {
    await adoptAsDefaultIfUnset(deps, providerId, template);
  } catch {
    /* best-effort — the user can still pick a default via the picker */
  }
  return true;
}

/**
 * Resolve a sensible default model id for a just-added provider: an explicit
 * saved model wins, otherwise the first model the catalog knows for it.
 * Returns undefined when neither source yields a model (e.g. a custom provider
 * with no `models` list and no catalog entry) — the caller then skips adoption.
 */
async function resolveDefaultModelId(
  deps: AuthMenuDeps,
  providerId: string,
  template: Partial<ProviderConfig>,
): Promise<string | undefined> {
  if (template.models && template.models.length > 0) return template.models[0];
  // Gateways publish under a models.dev id of their own (`ai-gateway` →
  // `vercel`); without the alias the lookup misses and the provider is added
  // with no default model at all.
  const catalogId = catalogProviderIdFor(providerId, template.type);
  const provider = await deps.modelsRegistry.getProvider(catalogId).catch(() => undefined);
  return provider?.models?.[0]?.id;
}

/**
 * Adopt `providerId` as the global default provider/model when none is set.
 * Reads the raw config (provider/model are plaintext top-level keys) so we
 * never clobber an existing choice, then persists via {@link saveToGlobalConfig}.
 */
async function adoptAsDefaultIfUnset(
  deps: AuthMenuDeps,
  providerId: string,
  template: Partial<ProviderConfig>,
): Promise<void> {
  const targetPath = deps.profileConfigPath;
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(await fs.readFile(targetPath, 'utf8')) as Record<string, unknown>;
  } catch {
    // Missing/unparsable config — treat as "no default set" and continue.
  }
  if (cfg['provider'] && cfg['model']) return; // already has a usable default

  const modelId = await resolveDefaultModelId(deps, providerId, template);
  if (!modelId) return; // nothing concrete to point the default at

  // Write straight to the same config path we just saved the provider into.
  // Re-serialising the parsed object preserves the vault-encrypted provider
  // blobs verbatim (we never decrypt here), and scoping the write to
  // the resolved profile target keeps it path-honest — unlike saveToGlobalConfig, whose
  // backup step targets the real ~/.wrongstack regardless of the path passed.
  cfg['provider'] = providerId;
  cfg['model'] = modelId;
  await atomicWrite(targetPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  deps.renderer.write(
    `  ${color.green('✓')} Set ${color.bold(providerId)}/${color.bold(modelId)} as the default.\n`,
  );
}

async function promptForLabel(deps: AuthMenuDeps, usedLabels: Set<string>): Promise<string | null> {
  const defaultLabel = suggestLabel(usedLabels);
  const labelRaw = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Label for this key ${color.dim(`[${defaultLabel}]`)}: `,
    )
  ).trim();
  const label = labelRaw || defaultLabel;
  if (usedLabels.has(label)) {
    deps.renderer.writeError(`Label "${label}" is already used. Use update (u) instead.`);
    return null;
  }
  return label;
}
